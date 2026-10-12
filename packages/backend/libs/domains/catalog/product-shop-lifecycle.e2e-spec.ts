import { Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { productEventSchemas } from '@marketplace-sandbox/contracts';
import { OWNERSHIP } from '../../../db/ownership';
import { CacheService } from '@app/infrastructure/cache';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ShopDeleted, ShopStatusChanged } from '@app/domains/tenancy';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createProduct,
  createProducts,
  productEvents,
} from '@app/test/utils/catalog-fixtures';
import { readTopic } from '@app/test/utils/kafka-test';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { ProductBackfillService } from './application/product-backfill.service';
import { ProductProjectorModule } from './product-projector.module';
import { ProductWorkerModule } from './product-worker.module';
import { ProductBackfillJobs } from './infra/product-backfill.jobs';
import { productCacheKey } from './infra/product-cache';
import { ShopLifecycleJobs } from './infra/shop-lifecycle.jobs';
import { SequelizeShopSweepRepository } from './infra/shop-lifecycle.repository';
import {
  ShopDeletedConsumer,
  ShopStatusConsumer,
} from './infra/shop-consumers';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import {
  createShopWorld,
  productEntryExists,
} from './testing/catalog-spec-kit';

describe('Product and shop lifecycle', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;

  const rows = <T extends object>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements });

  beforeAll(async () => {
    t = await createCatalogApp({
      extraImports: [JobsModule, ProductProjectorModule, ProductWorkerModule],
    });
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  describe('storage backstop (schema)', () => {
    it('S05 AS-58: the database refuses a negative quantity and a quantity above 1,000,000,000', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const product = await createProduct(t.app, shop, { quantity: 3 });

      await expect(
        createProduct(t.app, shop, { quantity: -1 }),
      ).rejects.toThrow(/Product_quantity_check/);
      await expect(
        createProduct(t.app, shop, { quantity: 1_000_000_001 }),
      ).rejects.toThrow(/Product_quantity_check/);
      await expect(
        sequelize.query(
          `UPDATE "Product" SET "quantity" = -1 WHERE "id" = :id`,
          { replacements: { id: product.id } },
        ),
      ).rejects.toThrow(/Product_quantity_check/);

      const [kept] = await rows<{ quantity: number }>(
        `SELECT "quantity" FROM "Product" WHERE "id" = :id`,
        { id: product.id },
      );
      expect(kept.quantity).toBe(3);
    });

    it('S05 AS-58: the database refuses a second product with the same (shopId, externalSku) and allows it in another shop', async () => {
      const owner = await t.newUser();
      const shopA = await createShop(t.app, owner);
      const shopB = await createShop(t.app, owner);
      await createProduct(t.app, shopA, { externalSku: 'SKU-1' });

      await expect(
        createProduct(t.app, shopA, { externalSku: 'SKU-1' }),
      ).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
      await createProduct(t.app, shopB, { externalSku: 'SKU-1' });
      await createProduct(t.app, shopA, { externalSku: null });
      await createProduct(t.app, shopA, { externalSku: null });
    });

    it('S05 AS-58: the database refuses a version below 1 and an unknown status', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      await expect(createProduct(t.app, shop, { version: 0 })).rejects.toThrow(
        /Product_version_check/,
      );
      await expect(
        createProduct(t.app, shop, { status: 'DELETED' as 'ACTIVE' }),
      ).rejects.toThrow(/Product_status_check/);
    });

    it('S05 AS-58: price and priceMinor stay equal whichever one a legacy writer sets', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const id = '0198a000-0000-7000-8000-000000000001';
      await sequelize.query(
        `INSERT INTO "Product" ("id","shopId","title","description","brand","category","price","createdAt","updatedAt")
         VALUES (:id, :shopId, 'Legacy', 'd', 'b', 'c', 4200, now(), now())`,
        { replacements: { id, shopId: shop.id } },
      );
      const [inserted] = await rows<{
        price: string;
        priceMinor: string;
        version: number;
        status: string;
        currency: string;
      }>(`SELECT * FROM "Product" WHERE "id" = :id`, { id });
      expect(inserted).toMatchObject({
        price: '4200',
        priceMinor: '4200',
        version: 1,
        status: 'ACTIVE',
      });

      await sequelize.query(
        `UPDATE "Product" SET "price" = 5000 WHERE "id" = :id`,
        { replacements: { id } },
      );
      await sequelize.query(
        `UPDATE "Product" SET "priceMinor" = 6000 WHERE "id" = :id`,
        { replacements: { id } },
      );
      const [updated] = await rows<{ price: string; priceMinor: string }>(
        `SELECT "price","priceMinor" FROM "Product" WHERE "id" = :id`,
        { id },
      );
      expect(updated).toEqual({ price: '6000', priceMinor: '6000' });
    });
  });

  describe('ownership constraints (schema)', () => {
    const NEW_TABLES = [
      'ProductStatusHistory',
      'ProductStockOperation',
      'ProductShopState',
      'ProductViewBatch',
    ];

    it('S05 AS-80: the four new tables exist and carry no foreign key', async () => {
      const found = await rows<{ name: string }>(
        `SELECT table_name::text AS name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN (:names)`,
        { names: NEW_TABLES },
      );
      expect(found.map((r) => r.name).sort()).toEqual([...NEW_TABLES].sort());
      const foreignKeys = await rows<{ conrelid: string }>(
        `SELECT conrelid::regclass::text AS conrelid FROM pg_constraint
         WHERE contype = 'f' AND conrelid::regclass::text IN (:quoted)`,
        { quoted: NEW_TABLES.map((n) => `"${n}"`).concat(NEW_TABLES) },
      );
      expect(foreignKeys).toEqual([]);
    });

    it('S05 AS-80: the ownership registry lists Product and its four tables as domain:catalog', () => {
      for (const name of ['Product', ...NEW_TABLES])
        expect((OWNERSHIP as Record<string, string>)[name]).toBe(
          'domain:catalog',
        );
    });

    it('S05 AS-80: after the contract migrations Product has no foreign key to User or Shop, shopId is NOT NULL, its checks are validated and the S03 check is gone', async () => {
      const foreignKeys = await rows<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE contype = 'f' AND conrelid = '"Product"'::regclass
           AND confrelid IN ('"User"'::regclass, '"Shop"'::regclass)`,
      );
      expect(foreignKeys).toEqual([]);
      const [column] = await rows<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'Product' AND column_name = 'shopId'`,
      );
      expect(column.is_nullable).toBe('NO');
      const checks = await rows<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint
         WHERE conrelid = '"Product"'::regclass AND contype = 'c'
           AND conname IN ('Product_quantity_check','Product_version_check','Product_shopId_not_null')`,
      );
      expect(checks.map((c) => c.conname).sort()).toEqual([
        'Product_quantity_check',
        'Product_version_check',
      ]);
      expect(checks.every((c) => c.convalidated)).toBe(true);
      await expect(
        sequelize.query(
          `INSERT INTO "Product" ("id","title","description","brand","category","price","createdAt","updatedAt")
           VALUES (:id,'x','d','b','c',1,now(),now())`,
          { replacements: { id: uuidv7() } },
        ),
      ).rejects.toThrow(/shopId/);
    });
  });

  describe('no foreign key references Product (AS-80)', () => {
    it('S05 AS-80: no table holds a foreign key that references "Product"', async () => {
      const incoming = await rows<{ conrelid: string; conname: string }>(
        `SELECT conrelid::regclass::text AS conrelid, conname FROM pg_constraint
         WHERE contype = 'f' AND confrelid = '"Product"'::regclass`,
      );
      expect(incoming).toEqual([]);
    });
  });

  describe('sandbox shops (AS-81)', () => {
    it('S05 AS-81: a product created in a sandbox shop is flagged, every event carries isSandbox true and it is never public', async () => {
      const w = await createShopWorld(t);
      const sandbox = await createShop(t.app, w.owner, {
        sandboxOf: w.shop.id,
      });
      const created = await t
        .as(w.owner)
        .post(`/api/shops/${sandbox.id}/products`)
        .send({ title: 'T', brand: 'B', category: 'c', priceMinor: 100 })
        .expect(201);
      const [row] = await rows<{ isSandbox: boolean }>(
        `SELECT "isSandbox" FROM "Product" WHERE "id" = :id`,
        { id: created.body.id },
      );
      expect(row.isSandbox).toBe(true);
      const [event] = await productEvents(t.app, created.body.id);
      expect(
        productEventSchemas['catalog.product_created'].parse(event.payload),
      ).toMatchObject({ isSandbox: true });
      await t.http().get(`/api/products/${created.body.id}`).expect(404);
    });
  });

  describe('shop events (AS-76 to AS-78)', () => {
    let statusConsumer: ShopStatusConsumer;
    let deletedConsumer: ShopDeletedConsumer;
    let jobs: ShopLifecycleJobs;

    beforeAll(() => {
      statusConsumer = t.app.get(ShopStatusConsumer, { strict: false });
      deletedConsumer = t.app.get(ShopDeletedConsumer, { strict: false });
      jobs = t.app.get(ShopLifecycleJobs, { strict: false });
    });

    const statusEvent = (
      shopId: string,
      to: 'ACTIVE' | 'SUSPENDED',
      from: 'ACTIVE' | 'SUSPENDED',
      shopVersion: number,
    ) =>
      ShopStatusChanged.create(shopId, shopVersion, {
        shopId,
        from,
        to,
        shopVersion,
      });
    const shopState = async (shopId: string) =>
      (
        await rows<{ status: string; shopVersion: number }>(
          `SELECT "status","shopVersion" FROM "ProductShopState" WHERE "shopId" = :shopId`,
          { shopId },
        )
      )[0];
    const queuedJobs = (type: string, shopId: string) =>
      rows<{ payload: Record<string, unknown> }>(
        `SELECT "payload" FROM "Job" WHERE "type" = :type AND "payload"->>'shopId' = :shopId`,
        { type, shopId },
      );

    it('S05 AS-76: suspension stores the status, drops the 2,500 cached entries in batches of at most 1,000, hides the products, and reinstating shows them; a stale shopVersion is ignored', async () => {
      const w = await createShopWorld(t);
      const products = await createProducts(t.app, w.shop, 2_500);
      const redis = t.app.get(RedisService);
      await Promise.all(
        products
          .slice(0, 3)
          .map((p) => t.http().get(`/api/products/${p.id}`).expect(200)),
      );
      const pipeline = redis.client.pipeline();
      for (const p of products) pipeline.set(productCacheKey(p.id), '{}');
      await pipeline.exec();

      await statusConsumer.project([
        statusEvent(w.shop.id, 'SUSPENDED', 'ACTIVE', 5),
      ]);
      expect(await shopState(w.shop.id)).toEqual({
        status: 'SUSPENDED',
        shopVersion: 5,
      });
      expect(
        await queuedJobs('products.drop-shop-entries', w.shop.id),
      ).toHaveLength(1);

      const invalidate = jest.spyOn(CacheService.prototype, 'invalidate');
      await jobs.dropEntries({ shopId: w.shop.id, shopVersion: 5 });
      expect(invalidate.mock.calls.map(([keys]) => keys.length)).toEqual([
        1_000, 1_000, 500,
      ]);
      invalidate.mockRestore();
      expect(await productEntryExists(t.app, products[0].id)).toBe(false);
      expect(await productEntryExists(t.app, products[2_499].id)).toBe(false);
      await t.http().get(`/api/products/${products[0].id}`).expect(404);
      const batch = await t
        .http()
        .get(`/api/batch/products?ids=${products[1].id}`)
        .expect(200);
      expect(batch.body).toEqual([null]);

      await statusConsumer.project([
        statusEvent(w.shop.id, 'ACTIVE', 'SUSPENDED', 6),
      ]);
      await jobs.dropEntries({ shopId: w.shop.id, shopVersion: 6 });
      await t.http().get(`/api/products/${products[0].id}`).expect(200);

      const stale = await statusConsumer.project([
        statusEvent(w.shop.id, 'SUSPENDED', 'ACTIVE', 6),
      ]);
      expect(stale).toMatchObject({ applied: 0, stale: 1 });
      expect((await shopState(w.shop.id)).status).toBe('ACTIVE');
      // The same event twice enqueues the sweep once.
      expect(
        await queuedJobs('products.drop-shop-entries', w.shop.id),
      ).toHaveLength(2);
    }, 120_000);

    it('S05 AS-77: shop_deleted hides the products, purges them 500 per transaction with a catalog.product_deleted each (productVersion one above the last), removes dependants and the status copy, spares other shops, is idempotent and resumes after a failure', async () => {
      const w = await createShopWorld(t);
      const other = await createShopWorld(t);
      const products = await createProducts(t.app, w.shop, 1_200, {
        version: 4,
      });
      const [kept] = await createProducts(t.app, other.shop, 3);
      await sequelize.query(
        `INSERT INTO "ProductStatusHistory" ("productId","shopId","fromStatus","toStatus","productVersion","at")
         SELECT id, "shopId", 'ACTIVE', 'ARCHIVED', 2, now() FROM "Product" WHERE "shopId" IN (:a,:b)`,
        { replacements: { a: w.shop.id, b: other.shop.id } },
      );
      await sequelize.query(
        `INSERT INTO "ProductStockOperation" ("operationId","productId","shopId","delta","reason","quantityAfter","productVersion","appliedAt")
         SELECT 'op-' || id, id, "shopId", -1, 'checkout', 1, 2, now() FROM "Product" WHERE "shopId" IN (:a,:b)`,
        { replacements: { a: w.shop.id, b: other.shop.id } },
      );

      const event = ShopDeleted.create(w.shop.id, 9, {
        shopId: w.shop.id,
        shopVersion: 9,
      });
      await deletedConsumer.project([event]);
      await deletedConsumer.project([event]); // duplicate delivery
      expect(await shopState(w.shop.id)).toEqual({
        status: 'DELETED',
        shopVersion: 9,
      });
      expect(await queuedJobs('products.purge-shop', w.shop.id)).toHaveLength(
        1,
      );
      await t.http().get(`/api/products/${products[0].id}`).expect(404);

      // A failure in the second batch stops the run after the first batch committed.
      const original = SequelizeShopSweepRepository.prototype.deleteBatch;
      let calls = 0;
      jest
        .spyOn(SequelizeShopSweepRepository.prototype, 'deleteBatch')
        .mockImplementation(function (
          this: SequelizeShopSweepRepository,
          ...args
        ) {
          calls += 1;
          if (calls === 2) return Promise.reject(new Error('disk full'));
          return original.apply(this, args);
        });
      await expect(jobs.purgeShop({ shopId: w.shop.id })).rejects.toThrow(
        'disk full',
      );
      jest.restoreAllMocks();
      const [{ n: left }] = await rows<{ n: string }>(
        `SELECT count(*) AS n FROM "Product" WHERE "shopId" = :id`,
        { id: w.shop.id },
      );
      expect(Number(left)).toBe(700);

      await expect(jobs.purgeShop({ shopId: w.shop.id })).resolves.toEqual({
        deleted: 700,
      });
      await expect(jobs.purgeShop({ shopId: w.shop.id })).resolves.toEqual({
        deleted: 0,
      });

      const events = await productEvents(t.app, products[7].id);
      const deleted = events.filter(
        (e) => e.type === 'catalog.product_deleted',
      );
      expect(deleted).toHaveLength(1);
      expect(deleted[0].aggregateVersion).toBe(5);
      expect(
        productEventSchemas['catalog.product_deleted'].parse(
          deleted[0].payload,
        ),
      ).toEqual({
        productId: products[7].id,
        shopId: w.shop.id,
        productVersion: 5,
      });
      const [{ n: total }] = await rows<{ n: string }>(
        `SELECT count(*) AS n FROM "Outbox" WHERE "type" = 'catalog.product_deleted'`,
      );
      expect(Number(total)).toBe(1_200);

      for (const table of ['ProductStatusHistory', 'ProductStockOperation']) {
        const [a] = await rows<{ n: string }>(
          `SELECT count(*) AS n FROM "${table}" WHERE "shopId" = :id`,
          { id: w.shop.id },
        );
        const [b] = await rows<{ n: string }>(
          `SELECT count(*) AS n FROM "${table}" WHERE "shopId" = :id`,
          { id: other.shop.id },
        );
        expect([Number(a.n), Number(b.n)]).toEqual([0, 3]);
      }
      expect(await shopState(w.shop.id)).toBeUndefined();
      await t.http().get(`/api/products/${kept.id}`).expect(200);
    }, 120_000);
  });

  describe('legacy shop-id backfill (AS-79)', () => {
    beforeAll(async () => {
      await sequelize.query(
        `ALTER TABLE "Product" ALTER COLUMN "shopId" DROP NOT NULL`,
      );
    });
    afterAll(async () => {
      await sequelize.query(`DELETE FROM "Product" WHERE "shopId" IS NULL`);
      await sequelize.query(
        `ALTER TABLE "Product" ALTER COLUMN "shopId" SET NOT NULL`,
      );
    });

    const legacy = async (sellerId: string | null, n: number) => {
      const ids = Array.from({ length: n }, () => uuidv7());
      await sequelize.query(
        `INSERT INTO "Product" ("id","sellerId","title","description","brand","category","price","createdAt","updatedAt")
         SELECT unnest(CAST(:ids AS uuid[])), CAST(:sellerId AS uuid), 'Legacy', 'd', 'b', 'c', 100, now(), now()`,
        { replacements: { ids: `{${ids.join(',')}}`, sellerId } },
      );
      return ids;
    };

    it('S05 AS-79: legacy products get their owner shop in batches, one product_updated each with changedFields ["shopId"], a rerun is a no-op, two concurrent runs assign each product once, and products with no owner are counted', async () => {
      const service = t.app.get(ProductBackfillService, { strict: false });
      const sellerA = (await t.newUser()).id;
      const sellerB = (await t.newUser()).id;
      const idsA = await legacy(sellerA, 450);
      const idsB = await legacy(sellerB, 3);
      const orphans = await legacy(null, 2);

      const [first, second] = await Promise.all([
        service.runOnce(),
        service.runOnce(),
      ]);
      expect(first.products + second.products).toBe(453);

      const assigned = await rows<{
        id: string;
        shopId: string;
        version: number;
      }>(
        `SELECT "id","shopId","version" FROM "Product" WHERE "id" = ANY(CAST(:ids AS uuid[]))`,
        { ids: `{${[...idsA, ...idsB].join(',')}}` },
      );
      expect(assigned).toHaveLength(453);
      expect(
        new Set(
          assigned.filter((p) => idsA.includes(p.id)).map((p) => p.shopId),
        ).size,
      ).toBe(1);
      expect(assigned.every((p) => p.shopId && p.version === 2)).toBe(true);

      const events = await productEvents(t.app, idsA[0]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'catalog.product_updated',
        aggregateVersion: 2,
      });
      expect(
        productEventSchemas['catalog.product_updated'].parse(events[0].payload)
          .changedFields,
      ).toEqual(['shopId']);
      const [{ n: updates }] = await rows<{ n: string }>(
        `SELECT count(*) AS n FROM "Outbox" WHERE "type" = 'catalog.product_updated'`,
      );
      expect(Number(updates)).toBe(453);

      await expect(service.runOnce()).resolves.toEqual({
        sellers: 0,
        products: 0,
      });
      const [{ n: after }] = await rows<{ n: string }>(
        `SELECT count(*) AS n FROM "Outbox" WHERE "type" = 'catalog.product_updated'`,
      );
      expect(Number(after)).toBe(453);
      const [{ n: orphanCount }] = await rows<{ n: string }>(
        `SELECT count(*) AS n FROM "Product" WHERE "shopId" IS NULL AND "id" = ANY(CAST(:ids AS uuid[]))`,
        { ids: `{${orphans.join(',')}}` },
      );
      expect(Number(orphanCount)).toBe(2);
    }, 120_000);

    it('S05 AS-79: the job continues itself while owners remain and is enqueued once per deploy', async () => {
      const jobs = t.app.get(ProductBackfillJobs, { strict: false });
      await jobs.onApplicationBootstrap();
      await jobs.onApplicationBootstrap();
      const [{ n }] = await rows<{ n: string }>(
        `SELECT count(*) AS n FROM "Job" WHERE "type" = 'products.backfill-shop-ids'`,
      );
      expect(Number(n)).toBe(1);
    });
  });
});

describe('Shop events through the event stream', () => {
  const kit = new ConsumerKit();
  beforeAll(() => kit.start());
  afterAll(() => kit.stopAll());

  it('S05 AS-78: a shop event with a bad shopId, an unknown status or a non-integer shopVersion is dead-lettered without effect and later events are processed', async () => {
    const s = await kit.scenario();
    const name = `product-shop-status-${s.id}`;

    @Injectable()
    class StreamStatusConsumer extends ShopStatusConsumer {
      readonly name = name;
      readonly topics = [s.topic];
    }
    const app = await s.boot([StreamStatusConsumer], {
      imports: [ProductProjectorModule],
    });
    const db = app.get(Sequelize);
    const [good, later, bad] = [uuidv7(), uuidv7(), uuidv7()];
    const ok = (shopId: string, version: number) =>
      ShopStatusChanged.create(shopId, version, {
        shopId,
        from: 'ACTIVE',
        to: 'SUSPENDED',
        shopVersion: version,
      });
    const badId = { ...ok(bad, 2), aggregateId: 'not-a-uuid' };
    const badStatus = {
      ...ok(bad, 3),
      payload: { shopId: bad, from: 'ACTIVE', to: 'GONE', shopVersion: 3 },
    };
    const badVersion = {
      ...ok(bad, 4),
      payload: {
        shopId: bad,
        from: 'ACTIVE',
        to: 'SUSPENDED',
        shopVersion: 'x',
      },
    };

    await s.publishRaw(
      [ok(good, 1), badId, badStatus, badVersion, ok(later, 2)].map((e) => ({
        key: e.aggregateId,
        value: JSON.stringify(e),
      })),
    );

    const stored = (shopId: string) =>
      db.query(`SELECT 1 FROM "ProductShopState" WHERE "shopId" = :shopId`, {
        replacements: { shopId },
        type: QueryTypes.SELECT,
      });
    await waitFor(
      async () =>
        (await readTopic(`${name}.dlq`)).length === 3 &&
        (await stored(good)).length === 1 &&
        (await stored(later)).length === 1,
      { description: '3 dead letters, the two good events applied' },
    );
    expect(await stored(bad)).toHaveLength(0);
  });
});
