import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  problemDetailsSchema,
  productEventSchemas,
  productMemberSchema,
  type ProductEventType,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  createProduct,
  productEvents,
  productRow,
} from '@app/test/utils/catalog-fixtures';
import { ProductStockService } from '@app/domains/catalog';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ProductMaintenanceJobs } from './infra/product-maintenance.jobs';
import { ProductWorkerModule } from './product-worker.module';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import {
  catalogEventCount,
  createShopWorld,
  productEntryExists,
  warmProductEntry,
  type ShopWorld,
} from './testing/catalog-spec-kit';

const body = {
  title: 'Wool coat',
  description: 'Warm',
  brand: 'Nord',
  category: 'coats',
  priceMinor: 12_900,
  quantity: 5,
  tags: ['winter'],
};

describe('Product events and observability', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;
  let w: ShopWorld;
  const base = () => `/api/shops/${w.shop.id}/products`;

  beforeAll(async () => {
    t = await createCatalogApp();
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
  });
  afterEach(() => jest.restoreAllMocks());

  it('S05 AS-82: every outbox payload of the write path parses with its schema; aggregateVersion rises by exactly 1 per product; a no-op writes none', async () => {
    const created = await t.as(w.staff).post(base()).send(body).expect(201);
    const id = created.body.id as string;
    const updated = await t
      .as(w.staff)
      .patch(`${base()}/${id}`)
      .send({ expectedVersion: 1, priceMinor: 9_900 })
      .expect(200);
    await t
      .as(w.staff)
      .patch(`${base()}/${id}`)
      .send({ expectedVersion: updated.body.version, priceMinor: 9_900 })
      .expect(200); // no-op
    const archived = await t
      .as(w.staff)
      .post(`${base()}/${id}/archive`)
      .send({ expectedVersion: 2 })
      .expect(200);
    await t
      .as(w.staff)
      .post(`${base()}/${id}/restore`)
      .send({ expectedVersion: archived.body.version })
      .expect(200);

    const events = await productEvents(t.app, id);
    expect(events.map((e) => e.type)).toEqual([
      'catalog.product_created',
      'catalog.product_updated',
      'catalog.product_archived',
      'catalog.product_restored',
    ]);
    expect(events.map((e) => e.aggregateVersion)).toEqual([1, 2, 3, 4]);
    for (const event of events) {
      expect(event).toMatchObject({
        topic: 'products.events',
        aggregateType: 'products',
        aggregateId: id,
        version: 1,
      });
      expect(event.eventId).toBeTruthy();
      expect(new Date(event.occurredAt).getTime()).not.toBeNaN();
      const payload = productEventSchemas[event.type as ProductEventType].parse(
        event.payload,
      ) as { productVersion: number };
      expect(payload.productVersion).toBe(event.aggregateVersion);
    }
  });

  it('S05 AS-83: when the outbox insert fails the whole write rolls back: row unchanged, no history row, cache entry kept', async () => {
    const product = await createProduct(t.app, w.shop, { version: 2 });
    await warmProductEntry(t.app, product.id, 2);
    await sequelize.query(`
      CREATE OR REPLACE FUNCTION fail_catalog_outbox() RETURNS trigger AS $$
      BEGIN
        IF NEW."type" LIKE 'catalog.%' THEN RAISE EXCEPTION 'outbox is down'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_catalog_outbox_trg BEFORE INSERT ON "Outbox"
        FOR EACH ROW EXECUTE FUNCTION fail_catalog_outbox();`);
    try {
      const calls = [
        t
          .as(w.staff)
          .patch(`${base()}/${product.id}`)
          .send({ expectedVersion: 2, title: 'Edited' }),
        t
          .as(w.staff)
          .post(`${base()}/${product.id}/archive`)
          .send({ expectedVersion: 2 }),
        t.as(w.staff).post(base()).send(body),
      ];
      for (const call of calls) {
        const res = await call;
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(problemDetailsSchema.safeParse(res.body).success).toBe(true);
      }
    } finally {
      await sequelize.query(`
        DROP TRIGGER IF EXISTS fail_catalog_outbox_trg ON "Outbox";
        DROP FUNCTION IF EXISTS fail_catalog_outbox();`);
    }

    const stored = await productRow<{
      version: number;
      title: string;
      status: string;
    }>(t.app, product.id);
    expect(stored).toMatchObject({
      version: 2,
      title: product.title,
      status: 'ACTIVE',
    });
    const history = await sequelize.query<{ n: string }>(
      `SELECT count(*) AS n FROM "ProductStatusHistory"`,
      { type: QueryTypes.SELECT },
    );
    expect(Number(history[0].n)).toBe(0);
    const count = await sequelize.query<{ n: string }>(
      `SELECT count(*) AS n FROM "Product" WHERE "shopId" = :s`,
      { type: QueryTypes.SELECT, replacements: { s: w.shop.id } },
    );
    expect(Number(count[0].n)).toBe(1);
    expect(await catalogEventCount(t.app)).toBe(0);
    expect(await productEntryExists(t.app, product.id)).toBe(true);
  });

  it('S05 AS-85: each write logs one audit line with requestId and ids and no body; the write counter moves; errors are problem+json with code, status and type', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const all: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((...args) => {
      all.push(JSON.stringify(args));
      const first = args[0];
      if (first && typeof first === 'object' && 'action' in first)
        lines.push(first as Record<string, unknown>);
    });
    const counter = (operation: string, result: string) =>
      MetricsRegistry.value('catalog_product_write_total', {
        operation,
        result,
      }) ?? 0;
    const createdBefore = counter('create', 'ok');
    const conflictBefore = counter('update', 'conflict');

    const created = await t
      .as(w.staff)
      .post(base())
      .send({ ...body, description: 'secret-description-text' })
      .expect(201);
    const id = productMemberSchema.parse(created.body).id;
    const conflict = await t
      .as(w.staff)
      .patch(`${base()}/${id}`)
      .send({ expectedVersion: 7, title: 'Edited' })
      .expect(409);
    await t
      .as(w.staff)
      .post(`${base()}/${id}/archive`)
      .send({ expectedVersion: 1 })
      .expect(200);

    expect(lines.map((l) => l.action)).toEqual([
      'product.created',
      'product.archived',
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({
        shopId: w.shop.id,
        productId: id,
        actorId: w.staff.id,
      });
      expect(typeof line.requestId).toBe('string');
      expect(line.requestId).toBeTruthy();
    }
    expect(all.join('\n')).not.toMatch(/secret-description-text|Wool coat/);

    expect(counter('create', 'ok')).toBe(createdBefore + 1);
    expect(counter('update', 'conflict')).toBe(conflictBefore + 1);
    for (const labels of MetricsRegistry.labelSets(
      'catalog_product_write_total',
    ))
      expect(Object.keys(labels).sort()).toEqual(['operation', 'result']);

    const problem = problemDetailsSchema.parse(conflict.body);
    expect(problem).toMatchObject({
      status: 409,
      code: 'version_conflict',
      currentVersion: 1,
    });
    expect(problem.type).toMatch(/version_conflict$/);
    expect(conflict.headers['content-type']).toMatch(/problem\+json/);
  });
});

describe('Stock operation retention', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;
  let jobs: ProductMaintenanceJobs;
  let stock: ProductStockService;

  const count = async (table: string, where = 'TRUE') =>
    Number(
      (
        await sequelize.query<{ n: string }>(
          `SELECT count(*) AS n FROM "${table}" WHERE ${where}`,
          { type: QueryTypes.SELECT },
        )
      )[0].n,
    );

  beforeAll(async () => {
    t = await createCatalogApp({
      extraImports: [JobsModule, ProductWorkerModule],
    });
    sequelize = t.app.get(Sequelize);
    jobs = t.app.get(ProductMaintenanceJobs);
    stock = t.app.get(ProductStockService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S05 AS-65: the purge deletes operation records older than 30 days, oldest first, at most 5,000 per run, keeps the younger ones, and a purged operationId is a new operation; view batch markers older than 7 days go too', async () => {
    const world = await createShopWorld(t);
    const product = await createProduct(t.app, world.shop, { quantity: 10 });
    const now = t.clock.now();
    const iso = (offsetMs: number) =>
      new Date(now.getTime() + offsetMs).toISOString();
    await sequelize.query(
      `INSERT INTO "ProductStockOperation"
         ("operationId","productId","shopId","delta","reason","quantityAfter","productVersion","appliedAt")
       SELECT 'old-' || i, :productId, :shopId, -1, 'checkout', 1, 1,
              CAST(:oldest AS timestamptz) + i * interval '1 second'
       FROM generate_series(1, 5500) AS i`,
      {
        replacements: {
          productId: product.id,
          shopId: world.shop.id,
          oldest: iso(-40 * 86_400_000),
        },
      },
    );
    await sequelize.query(
      `INSERT INTO "ProductStockOperation"
         ("operationId","productId","shopId","delta","reason","quantityAfter","productVersion","appliedAt")
       SELECT 'young-' || i, :productId, :shopId, -1, 'checkout', 1, 1, CAST(:at AS timestamptz)
       FROM generate_series(1, 10) AS i`,
      {
        replacements: {
          productId: product.id,
          shopId: world.shop.id,
          at: iso(-29 * 86_400_000),
        },
      },
    );
    await sequelize.query(
      `INSERT INTO "ProductViewBatch" ("batchId","chunk","appliedAt") VALUES
         (:a, 0, CAST(:old AS timestamptz)), (:b, 0, CAST(:old AS timestamptz)), (:c, 0, CAST(:young AS timestamptz))`,
      {
        replacements: {
          a: randomUUID(),
          b: randomUUID(),
          c: randomUUID(),
          old: iso(-8 * 86_400_000),
          young: iso(-6 * 86_400_000),
        },
      },
    );

    const first = await jobs.purgeStockOperations();
    expect(first.operations).toBe(5_000);
    expect(first.viewBatches).toBe(2);
    expect(
      await count('ProductStockOperation', `"operationId" LIKE 'old-%'`),
    ).toBe(500);
    // oldest first: what is left of the old ones is the newest 500
    expect(
      await count('ProductStockOperation', `"operationId" = 'old-5500'`),
    ).toBe(1);
    expect(
      await count('ProductStockOperation', `"operationId" = 'old-1'`),
    ).toBe(0);
    expect(await count('ProductViewBatch')).toBe(1);

    const second = await jobs.purgeStockOperations();
    expect(second.operations).toBe(500);
    expect(await count('ProductStockOperation')).toBe(10);
    expect(
      await count('ProductStockOperation', `"operationId" LIKE 'young-%'`),
    ).toBe(10);

    expect(await jobs.purgeStockOperations()).toEqual({
      operations: 0,
      viewBatches: 0,
    });

    // A purged id is no longer remembered: sending it again is a new operation (the documented limit).
    const result = await stock.applyStockDelta([
      {
        operationId: 'old-1',
        productId: product.id,
        shopId: world.shop.id,
        delta: -1,
        reason: 'checkout',
      },
    ]);
    expect(result).toMatchObject({
      outcome: 'applied',
      results: [{ replayed: false, quantityAfter: 9 }],
    });
  });
});
