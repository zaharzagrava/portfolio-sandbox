import { randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import {
  conflictPageSchema,
  stockConflictSchema,
} from '@marketplace-sandbox/contracts';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import {
  IntegrationsModule,
  IntegrationsProjectorModule,
  IntegrationsWorkerModule,
} from './integrations.module';
import { SyncEngineService } from './application/sync-engine.service';
import { serialiseCredentials } from './domain/credentials';
import {
  CATALOG_GATEWAY,
  CONFLICT_REPOSITORY,
  CREDENTIAL_VAULT,
  INTEGRATION_REPOSITORY,
  type CatalogGateway,
  type ConflictRecord,
  type ConflictRepository,
  type CredentialVault,
  type IntegrationRepository,
  type SyncMessage,
} from './domain/ports';
import { ProductEventsConsumer } from './infra/product-events.consumer';
import {
  PROVIDER_NETWORK,
  type ProviderNetwork,
} from './infra/provider-network';
import { FakeShopify } from './test/fakes/fake-shopify';
import { testNetworkFor } from './test/fakes/provider-harness';
import { createStubResolver } from './test/fakes/stub-resolver';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';

const MIN = 60_000;
const SCOPES = 'read_products,read_inventory,write_inventory,read_locations';

const stores = new Map<string, string>();
const resolver = createStubResolver();
const network: ProviderNetwork = {
  resolver: resolver.resolve,
  unsafeTestNetwork: testNetworkFor(),
  sleep: async () => undefined,
  originFor: (target) =>
    target.provider === 'shopify' ? stores.get(target.shopDomain) : undefined,
};

describe('Integration bidirectional stock', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let engine: SyncEngineService;
  let consumer: ProductEventsConsumer;
  let gateway: CatalogGateway;
  let integrations: IntegrationRepository;
  let conflicts: ConflictRepository;
  let vault: CredentialVault;
  let stockSpy: jest.SpyInstance;
  const fakes: FakeShopify[] = [];
  const integrationIds: string[] = [];

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [
        IntegrationsModule,
        IntegrationsWorkerModule,
        IntegrationsProjectorModule,
      ],
      overrides: [{ provide: PROVIDER_NETWORK, useValue: network }],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    const worker = ctx.app.select(IntegrationsWorkerModule);
    engine = worker.get(SyncEngineService);
    integrations = worker.get(INTEGRATION_REPOSITORY);
    conflicts = worker.get(CONFLICT_REPOSITORY);
    vault = worker.get(CREDENTIAL_VAULT);
    gateway = worker.get(CATALOG_GATEWAY);
    consumer = ctx.app
      .select(IntegrationsProjectorModule)
      .get(ProductEventsConsumer);
    stockSpy = jest.spyOn(gateway, 'applyStockDelta');
    jest.spyOn(ctx.app.get(TaskQueue), 'enqueue').mockResolvedValue('m');
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    stockSpy.mockClear();
    resolver.reset();
    stores.clear();
  });

  afterEach(async () => {
    for (const f of fakes.splice(0)) await f.stop();
    await db.query(
      `DROP TRIGGER IF EXISTS s08_fail_stock_trg ON "ExternalLink"`,
    );
    await db.query(`DROP FUNCTION IF EXISTS s08_fail_stock_fn()`);
    await db.query(`DROP SEQUENCE IF EXISTS s08_fail_stock_seq`);
    if (integrationIds.length) {
      const replacements = { ids: integrationIds };
      for (const table of [
        'SyncRun',
        'SyncCursor',
        'ExternalLink',
        'SyncQuarantine',
        'StockConflict',
        'IntegrationHistory',
      ])
        await db.query(
          `DELETE FROM "${table}" WHERE "integrationId" IN (:ids)`,
          { replacements },
        );
      await db.query(`DELETE FROM "Integration" WHERE "id" IN (:ids)`, {
        replacements,
      });
      integrationIds.length = 0;
    }
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  async function world() {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    const domain = `stock-${randomUUID().slice(0, 8)}.myshopify.com`;
    const fake = new FakeShopify({ shopDomain: domain, pageSize: 10 });
    fake.now = () => ctx.clock.now();
    await fake.start();
    fakes.push(fake);
    stores.set(domain, fake.baseUrl);
    const id = randomUUID();
    const inserted = await integrations.insertConnected({
      id,
      shopId: shop.id,
      provider: 'shopify',
      externalShop: domain,
      credentialsSealed: vault.seal(
        id,
        serialiseCredentials({
          provider: 'shopify',
          accessToken: fake.accessToken,
          scope: SCOPES,
        }),
      ),
      locationId: String(fake.locationId),
      connectedBy: owner.id,
      now: ctx.clock.now(),
      maxPerShop: 5,
    });
    expect(inserted.kind).toBe('inserted');
    integrationIds.push(id);
    return { owner, shopId: shop.id, fake, id };
  }

  /** A linked variant: the provider holds `stock`, the backfill imported it, so local = base = remote = `stock`. */
  async function linked(stock: number) {
    const w = await world();
    const remote = w.fake.addProduct({ title: 'Mug', stock });
    const variantId = remote.variants[0].id;
    expect(await engine.handle(backfill(w.id))).toBe('completed');
    const link = (await links(w.id))[0];
    return {
      ...w,
      remote,
      variantId,
      productId: link.localId as string,
      externalId: link.externalId as string,
    };
  }

  const backfill = (integrationId: string): SyncMessage => ({
    integrationId,
    kind: 'backfill',
  });
  const incremental = (integrationId: string): SyncMessage => ({
    integrationId,
    kind: 'incremental',
  });

  const links = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "ExternalLink" WHERE "integrationId" = :integrationId ORDER BY "externalId"`,
      { type: QueryTypes.SELECT, replacements: { integrationId } },
    );

  const product = async (productId: string) =>
    (
      await db.query<Record<string, any>>(
        `SELECT * FROM "Product" WHERE "id" = :productId`,
        {
          type: QueryTypes.SELECT,
          replacements: { productId },
        },
      )
    )[0];

  const productsOf = (shopId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "Product" WHERE "shopId" = :shopId`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId },
      },
    );

  const conflictRows = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "StockConflict" WHERE "integrationId" = :integrationId ORDER BY "createdAt"`,
      {
        type: QueryTypes.SELECT,
        replacements: { integrationId },
      },
    );

  const conflictEvents = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT payload FROM "Outbox" WHERE "type" = 'catalogsync.stock_conflict_opened' AND payload->'payload'->>'integrationId' = :integrationId`,
      { type: QueryTypes.SELECT, replacements: { integrationId } },
    );

  /** A local stock change by any capability: the catalog's stock command. */
  async function localChange(
    shopId: string,
    productId: string,
    delta: number,
    reason = 'sale',
  ) {
    const outcome = await gateway.applyStockDelta([
      { operationId: `test-${randomUUID()}`, productId, shopId, delta, reason },
    ]);
    expect(outcome.kind).toBe('applied');
  }

  /** The envelopes of the product events the catalog appended to the outbox, oldest version first. */
  async function productEvents(productId: string): Promise<EventEnvelope[]> {
    const found = await db.query<{ payload: EventEnvelope }>(
      `SELECT payload FROM "Outbox" WHERE "aggregateId" = :productId AND "type" LIKE 'catalog.product\\_%'
        ORDER BY (payload->>'aggregateVersion')::int, "createdAt"`,
      { type: QueryTypes.SELECT, replacements: { productId } },
    );
    return found
      .map((r) => r.payload)
      .filter((e) => e.type !== 'catalog.product_changed');
  }

  const latestEvent = async (productId: string) =>
    (await productEvents(productId)).at(-1)!;

  const accepted = (fake: FakeShopify) =>
    fake.stockWrites.filter((r) => r.status === 200);
  const written = (r: { body?: unknown }) =>
    r.body as { available: number; change_from_quantity: number };

  async function remoteMoves(fake: FakeShopify, variantId: number, to: number) {
    ctx.clock.advance(MIN);
    fake.setRemoteStock(variantId, to);
  }

  async function stockResultOf(call: number) {
    return (await stockSpy.mock.results[call].value) as {
      kind: string;
      results: Array<{ replayed: boolean }>;
    };
  }

  // ---- AS-35 ---------------------------------------------------------------------------------------------------

  it('S08 AS-35: a provider stock of 7 against base 10 and local 10 is one inbound -3 command with a deterministic operation id and no provider write', async () => {
    const t = await linked(10);
    await remoteMoves(t.fake, t.variantId, 7);

    expect(await engine.handle(incremental(t.id))).toBe('completed');

    expect(stockSpy).toHaveBeenCalledTimes(1);
    const ops = stockSpy.mock.calls[0][0];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      productId: t.productId,
      shopId: t.shopId,
      delta: -3,
      reason: 'sync-inbound',
    });
    expect(ops[0].operationId).toMatch(
      new RegExp(`^sync:${t.id}:[0-9a-f]{16,}$`),
    );
    expect((await product(t.productId)).quantity).toBe(7);
    expect((await links(t.id))[0].syncedStock).toBe(7);
    expect(t.fake.stockWrites).toHaveLength(0);
  });

  // ---- AS-36 ---------------------------------------------------------------------------------------------------

  it.each([
    ['a sale', 'sale'],
    ['an offline-sync style writer', 'offline-sync'],
  ])(
    'S08 AS-36: %s lowering 10 to 8 is one conditional write "set 8 expected 10"; the echo applies and pushes nothing',
    async (_name, reason) => {
      const t = await linked(10);
      await localChange(t.shopId, t.productId, -2, reason);

      await consumer.project(await productEvents(t.productId));

      expect(t.fake.stockWrites).toHaveLength(1);
      expect(written(t.fake.stockWrites[0])).toMatchObject({
        available: 8,
        change_from_quantity: 10,
      });
      expect(t.fake.stockOf(t.variantId)).toBe(8);
      const link = (await links(t.id))[0];
      expect(link.syncedStock).toBe(8);
      expect(link.lastStockWriteAt).not.toBeNull();

      // The provider's updatedAt moved because of our write: the next pull returns the item and applies nothing.
      ctx.clock.advance(MIN);
      stockSpy.mockClear();
      expect(await engine.handle(incremental(t.id))).toBe('completed');
      expect(stockSpy).not.toHaveBeenCalled();
      expect(t.fake.stockWrites).toHaveLength(1);
      expect((await product(t.productId)).quantity).toBe(8);
    },
  );

  // ---- AS-37 ---------------------------------------------------------------------------------------------------

  it.each(['pull first', 'push first'])(
    'S08 AS-37: both sides sold (local 8, provider 7, base 10), %s: both end at 5, no conflict, one accepted provider write',
    async (order) => {
      const t = await linked(10);
      await localChange(t.shopId, t.productId, -2);
      await remoteMoves(t.fake, t.variantId, 7);
      const events = await productEvents(t.productId);

      if (order === 'pull first') {
        expect(await engine.handle(incremental(t.id))).toBe('completed');
        await consumer.project(events);
      } else {
        await consumer.project(events);
        expect(await engine.handle(incremental(t.id))).toBe('completed');
      }

      expect((await product(t.productId)).quantity).toBe(5);
      expect(t.fake.stockOf(t.variantId)).toBe(5);
      expect((await links(t.id))[0].syncedStock).toBe(5);
      expect(await conflictRows(t.id)).toHaveLength(0);
      expect(accepted(t.fake).map((r) => written(r).available)).toEqual([5]);
      if (order === 'push first') {
        // The conditional write "set 8 expected 10" was refused: the provider holds 7. It was abandoned, not forced.
        const refused = t.fake.stockWrites.filter((r) => r.status !== 200);
        expect(refused).toHaveLength(1);
        expect(written(refused[0])).toMatchObject({
          available: 8,
          change_from_quantity: 10,
        });
      }
      // Everything settled: nothing more happens.
      ctx.clock.advance(MIN);
      const writes = t.fake.stockWrites.length;
      await engine.handle(incremental(t.id));
      await consumer.project(await productEvents(t.productId));
      expect(t.fake.stockWrites).toHaveLength(writes);
      expect((await product(t.productId)).quantity).toBe(5);
    },
  );

  // ---- AS-38 ---------------------------------------------------------------------------------------------------

  it('S08 AS-38: oversold (base 3, local 0, provider 1) sets both sides to 0 and opens one conflict and one event, also when merged again', async () => {
    const t = await linked(3);
    await localChange(t.shopId, t.productId, -3);
    await remoteMoves(t.fake, t.variantId, 1);

    expect(await engine.handle(incremental(t.id))).toBe('completed');

    expect((await product(t.productId)).quantity).toBe(0);
    expect(t.fake.stockOf(t.variantId)).toBe(0);
    expect((await links(t.id))[0].syncedStock).toBe(0);
    const rows = await conflictRows(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'oversold',
      base: 3,
      local: 0,
      remote: 1,
      merged: -2,
      resolvedTo: 0,
      status: 'OPEN',
      productId: t.productId,
      shopId: t.shopId,
      externalId: t.externalId,
    });
    const events = await conflictEvents(t.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.payload).toMatchObject({
      conflictId: rows[0].id,
      integrationId: t.id,
      shopId: t.shopId,
      productId: t.productId,
      kind: 'oversold',
      base: 3,
      local: 0,
      remote: 1,
      resolvedTo: 0,
    });

    // A rerun finds both sides equal: nothing happens.
    ctx.clock.advance(MIN);
    expect(await engine.handle(incremental(t.id))).toBe('completed');
    expect(await conflictRows(t.id)).toHaveLength(1);

    // The very same merge again (same base, local, remote) re-uses the open conflict: no second row, no second event.
    await db.query(
      `UPDATE "ExternalLink" SET "syncedStock" = 3 WHERE "integrationId" = :id`,
      { replacements: { id: t.id } },
    );
    await remoteMoves(t.fake, t.variantId, 1);
    expect(await engine.handle(incremental(t.id))).toBe('completed');
    expect(await conflictRows(t.id)).toHaveLength(1);
    expect(await conflictEvents(t.id)).toHaveLength(1);
    expect((await product(t.productId)).quantity).toBe(0);
    expect(t.fake.stockOf(t.variantId)).toBe(0);
  });

  // ---- AS-39 ---------------------------------------------------------------------------------------------------

  describe('conflict routes', () => {
    async function openConflict(
      t: { id: string; shopId: string; productId: string; externalId: string },
      n: number,
    ) {
      const out: ConflictRecord[] = [];
      for (let i = 0; i < n; i++) {
        ctx.clock.advance(1000);
        const { conflict } = await conflicts.open(
          {
            integrationId: t.id,
            shopId: t.shopId,
            externalId: t.externalId,
            productId: t.productId,
            kind: 'oversold',
            base: 3 + i,
            local: 0,
            remote: 1,
            merged: -2 - i,
            resolvedTo: 0,
          },
          ctx.clock.now(),
        );
        out.push(conflict);
      }
      return out;
    }

    it('S08 AS-39: lists newest first with an opaque cursor, refuses a tampered one, dismisses once, hides other shops, changes no stock', async () => {
      const t = await linked(5);
      const created = await openConflict(t, 3);
      const base = `/api/shops/${t.shopId}/integrations/${t.id}/conflicts`;

      const first = await ctx.as(t.owner).get(`${base}?status=OPEN&limit=2`);
      expect(first.status).toBe(200);
      const page1 = conflictPageSchema.parse(first.body);
      expect(page1.items.map((c) => c.id)).toEqual([
        created[2].id,
        created[1].id,
      ]);
      expect(page1.nextCursor).not.toBeNull();
      const second = await ctx
        .as(t.owner)
        .get(
          `${base}?status=OPEN&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        );
      const page2 = conflictPageSchema.parse(second.body);
      expect(page2.items.map((c) => c.id)).toEqual([created[0].id]);
      expect(page2.nextCursor).toBeNull();

      const tampered = await ctx
        .as(t.owner)
        .get(
          `${base}?limit=2&cursor=${encodeURIComponent(page1.nextCursor!.slice(0, -2) + 'xx')}`,
        );
      expect(tampered.status).toBe(400);
      expect(tampered.body.code).toBe('invalid_cursor');

      const before = (await product(t.productId)).quantity;
      const dismissed = await ctx
        .as(t.owner)
        .post(`${base}/${created[1].id}/dismiss`);
      expect(dismissed.status).toBe(200);
      const body = stockConflictSchema.parse(dismissed.body);
      expect(body).toMatchObject({ id: created[1].id, status: 'DISMISSED' });
      expect(body.dismissedAt).not.toBeNull();
      const row = (await conflictRows(t.id)).find(
        (r) => r.id === created[1].id,
      )!;
      expect(row.dismissedBy).toBe(t.owner.id);
      expect(row.status).toBe('DISMISSED');

      const again = await ctx
        .as(t.owner)
        .post(`${base}/${created[1].id}/dismiss`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('conflict_not_open');

      const open = conflictPageSchema.parse(
        (await ctx.as(t.owner).get(`${base}?status=OPEN`)).body,
      );
      expect(open.items.map((c) => c.id).sort()).toEqual(
        [created[0].id, created[2].id].sort(),
      );

      const other = await linked(5);
      const foreign = await openConflict(other, 1);
      const cross = await ctx
        .as(t.owner)
        .post(`${base}/${foreign[0].id}/dismiss`);
      expect(cross.status).toBe(404);
      expect(cross.body.code).toBe('conflict_not_found');
      const wrongShop = await ctx
        .as(t.owner)
        .post(
          `/api/shops/${t.shopId}/integrations/${other.id}/conflicts/${foreign[0].id}/dismiss`,
        );
      expect(wrongShop.status).toBe(404);
      expect(wrongShop.body.code).toBe('conflict_not_found');
      expect((await conflictRows(other.id))[0].status).toBe('OPEN');

      expect((await product(t.productId)).quantity).toBe(before);
    });
  });

  // ---- AS-40 ---------------------------------------------------------------------------------------------------

  describe('product-event consumer', () => {
    /** A local sale 10 -> 8 whose event is the one under test. */
    async function sold() {
      const t = await linked(10);
      await localChange(t.shopId, t.productId, -2);
      return { ...t, event: await latestEvent(t.productId) };
    }
    const withPayload = (
      e: EventEnvelope,
      patch: Record<string, unknown>,
    ): EventEnvelope => ({
      ...e,
      payload: { ...e.payload, ...patch },
    });

    it('S08 AS-40: events of an unlinked product, a sandbox product, a change without quantity, or a non-active integration send nothing', async () => {
      const t = await sold();
      const unlinked = {
        ...t.event,
        eventId: randomUUID(),
        aggregateId: randomUUID(),
      };
      unlinked.payload = {
        ...unlinked.payload,
        productId: unlinked.aggregateId,
      };
      await consumer.project([unlinked]);
      await consumer.project([withPayload(t.event, { isSandbox: true })]);
      await consumer.project([
        withPayload(t.event, { changedFields: ['title'] }),
      ]);
      await db.query(
        `UPDATE "Integration" SET "status" = 'PAUSED', "pausedReason" = 'seller' WHERE "id" = :id`,
        {
          replacements: { id: t.id },
        },
      );
      await consumer.project([t.event]);
      expect(t.fake.stockWrites).toHaveLength(0);

      // Control: the same event on an ACTIVE integration does write (the filters above are what held it back).
      await db.query(
        `UPDATE "Integration" SET "status" = 'ACTIVE', "pausedReason" = NULL WHERE "id" = :id`,
        {
          replacements: { id: t.id },
        },
      );
      await consumer.project([t.event]);
      expect(t.fake.stockWrites).toHaveLength(1);
    });

    it('S08 AS-40: the same eventId twice, or an older version after a newer one, gives at most one push', async () => {
      const t = await linked(10);
      await localChange(t.shopId, t.productId, -2);
      const v8 = await latestEvent(t.productId);
      await localChange(t.shopId, t.productId, -2);
      const v6 = await latestEvent(t.productId);

      await consumer.project([v6]);
      await consumer.project([v6]);
      await consumer.project([v8]);

      expect(t.fake.stockWrites).toHaveLength(1);
      expect(written(t.fake.stockWrites[0])).toMatchObject({
        available: 6,
        change_from_quantity: 10,
      });
      expect(t.fake.stockOf(t.variantId)).toBe(6);
      expect((await links(t.id))[0].syncedStock).toBe(6);
    });

    it('S08 AS-40: the event of our own inbound apply (quantity equals syncedStock) sends nothing', async () => {
      const t = await linked(10);
      await remoteMoves(t.fake, t.variantId, 7);
      await engine.handle(incremental(t.id));
      expect((await product(t.productId)).quantity).toBe(7);

      await consumer.project(await productEvents(t.productId));

      expect(t.fake.stockWrites).toHaveLength(0);
    });

    it.each<[string, (e: EventEnvelope) => EventEnvelope]>([
      [
        'a missing productId',
        (e) => ({ ...e, payload: { ...e.payload, productId: undefined } }),
      ],
      [
        'a missing quantity',
        (e) => ({ ...e, payload: { ...e.payload, quantity: undefined } }),
      ],
      [
        'a productId that is not a UUID',
        (e) => withPayload(e, { productId: 'not-a-uuid' }),
      ],
      ['an unknown envelope version', (e) => ({ ...e, version: 2 })],
    ])(
      'S08 AS-40: %s is dead-lettered and nothing is sent',
      async (_name, break_) => {
        const t = await sold();
        await expect(
          consumer.project([break_(t.event)]),
        ).rejects.toBeInstanceOf(PermanentError);
        expect(t.fake.stockWrites).toHaveLength(0);
        expect((await links(t.id))[0].syncedStock).toBe(10);
      },
    );

    it("S08 AS-40: another shop's event cannot reach this shop's link", async () => {
      const t = await sold();
      const foreignShop = (await world()).shopId;
      await consumer.project([withPayload(t.event, { shopId: foreignShop })]);
      expect(t.fake.stockWrites).toHaveLength(0);
      expect((await links(t.id))[0].syncedStock).toBe(10);
      // Control: with the shop of the link the very same event does push.
      await consumer.project([t.event]);
      expect(t.fake.stockWrites).toHaveLength(1);
    });
  });

  // ---- AS-41 ---------------------------------------------------------------------------------------------------

  it('S08 AS-41: a page fetched before our latest stock write has its stock ignored and its fields applied', async () => {
    const t = await linked(10);
    ctx.clock.advance(MIN);
    t.fake.updateProduct(t.remote.id, { title: 'Mug renamed' });
    const gate = t.fake.gate(
      (r) => r.method === 'GET' && /\/products\.json$/.test(r.path),
      { once: true },
    );

    const run = engine.handle(incremental(t.id));
    await gate.reached;

    // While the page is in flight, a local sale is pushed: the write completes after the fetch began.
    ctx.clock.advance(MIN);
    await localChange(t.shopId, t.productId, -2);
    await consumer.project([await latestEvent(t.productId)]);
    expect(t.fake.stockOf(t.variantId)).toBe(8);
    // What the in-flight page shows is the old stock.
    t.fake.setRemoteStock(t.variantId, 10);
    stockSpy.mockClear();
    gate.release();

    expect(await run).toBe('completed');
    expect(stockSpy).not.toHaveBeenCalled();
    expect((await product(t.productId)).quantity).toBe(8);
    expect((await product(t.productId)).title).toContain('Mug renamed');
    expect((await links(t.id))[0].syncedStock).toBe(8);
  });

  // ---- AS-42 ---------------------------------------------------------------------------------------------------

  it('S08 AS-42: a crash after the catalog applied the delta replays the same operation id once; a later 10 -> 7 has another id', async () => {
    const t = await linked(10);
    await remoteMoves(t.fake, t.variantId, 7);
    await db.query(`CREATE SEQUENCE s08_fail_stock_seq`);
    await db.query(`
      CREATE FUNCTION s08_fail_stock_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW."integrationId" = '${t.id}' AND NEW."syncedStock" = 7 AND OLD."syncedStock" IS DISTINCT FROM 7
           AND nextval('s08_fail_stock_seq') = 1 THEN
          RAISE EXCEPTION 's08 forced syncedStock write failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await db.query(
      `CREATE TRIGGER s08_fail_stock_trg BEFORE UPDATE ON "ExternalLink" FOR EACH ROW EXECUTE FUNCTION s08_fail_stock_fn()`,
    );

    await expect(engine.handle(incremental(t.id))).rejects.toThrow(
      /forced syncedStock write failure/,
    );
    expect((await product(t.productId)).quantity).toBe(7);
    expect((await links(t.id))[0].syncedStock).toBe(10);
    expect(stockSpy).toHaveBeenCalledTimes(1);

    expect(await engine.handle(incremental(t.id))).toBe('completed');

    expect(stockSpy).toHaveBeenCalledTimes(2);
    const firstOperation = stockSpy.mock.calls[0][0][0].operationId as string;
    expect(stockSpy.mock.calls[1][0][0].operationId).toBe(firstOperation);
    expect((await stockResultOf(1)).results[0].replayed).toBe(true);
    expect((await product(t.productId)).quantity).toBe(7);
    expect((await links(t.id))[0].syncedStock).toBe(7);
    expect(t.fake.stockWrites).toHaveLength(0);

    // A later genuine change from 10 to 7 has another remote updatedAt, hence another operation id, and is applied.
    await remoteMoves(t.fake, t.variantId, 10);
    await engine.handle(incremental(t.id));
    expect((await product(t.productId)).quantity).toBe(10);
    stockSpy.mockClear();
    await remoteMoves(t.fake, t.variantId, 7);
    await engine.handle(incremental(t.id));
    expect(stockSpy).toHaveBeenCalledTimes(1);
    expect(stockSpy.mock.calls[0][0][0].operationId).not.toBe(firstOperation);
    expect((await product(t.productId)).quantity).toBe(7);
  });

  // ---- AS-43 ---------------------------------------------------------------------------------------------------

  describe('push failure', () => {
    it('S08 AS-43: 503 three times fails the run and leaves syncedStock; after recovery the provider equals local and syncedStock follows', async () => {
      const t = await linked(10);
      await localChange(t.shopId, t.productId, -2);
      ctx.clock.advance(MIN);
      t.fake.updateProduct(t.remote.id, { title: 'Mug renamed' });
      t.fake.inject({
        match: (r) =>
          r.method === 'POST' && /inventory_levels\/set\.json$/.test(r.path),
        fault: { kind: 'status', status: 503 },
        times: 3,
      });

      expect(await engine.handle(incremental(t.id))).toBe('failed');

      expect(t.fake.stockWrites).toHaveLength(3);
      expect((await links(t.id))[0].syncedStock).toBe(10);
      expect(t.fake.stockOf(t.variantId)).toBe(10);

      // The provider is back: the next pull (which still has the page, the watermark did not move) retries.
      expect(await engine.handle(incremental(t.id))).toBe('completed');
      expect(t.fake.stockOf(t.variantId)).toBe(8);
      expect((await links(t.id))[0].syncedStock).toBe(8);
      expect((await product(t.productId)).quantity).toBe(8);
    });

    it('S08 AS-43: the next product event retries a push that failed', async () => {
      const t = await linked(10);
      await localChange(t.shopId, t.productId, -2);
      const event = await latestEvent(t.productId);
      t.fake.inject({
        match: (r) =>
          r.method === 'POST' && /inventory_levels\/set\.json$/.test(r.path),
        fault: { kind: 'status', status: 503 },
        times: 3,
      });
      await consumer.project([event]);
      expect((await links(t.id))[0].syncedStock).toBe(10);
      expect(t.fake.stockOf(t.variantId)).toBe(10);

      await consumer.project([event]);
      expect(t.fake.stockOf(t.variantId)).toBe(8);
      expect((await links(t.id))[0].syncedStock).toBe(8);
    });

    it('S08 AS-43: a 404 for the variant marks the link DELETED_AT_PROVIDER and pushes nothing more', async () => {
      const t = await linked(10);
      await localChange(t.shopId, t.productId, -2);
      t.fake.inject({
        match: (r) =>
          r.method === 'POST' && /inventory_levels\/set\.json$/.test(r.path),
        fault: { kind: 'status', status: 404, json: { errors: 'Not Found' } },
      });

      await consumer.project([await latestEvent(t.productId)]);

      expect((await links(t.id))[0].state).toBe('DELETED_AT_PROVIDER');
      expect((await product(t.productId)).quantity).toBe(0);
      const writes = t.fake.stockWrites.length;
      await consumer.project([await latestEvent(t.productId)]);
      expect(t.fake.stockWrites).toHaveLength(writes);
    });
  });

  // ---- AS-44 ---------------------------------------------------------------------------------------------------

  it('S08 AS-44: three local changes 10 -> 9 -> 8 -> 7 in one batch are one conditional write "set 7 expected 10"', async () => {
    const t = await linked(10);
    for (let i = 0; i < 3; i++) await localChange(t.shopId, t.productId, -1);
    const events = (await productEvents(t.productId)).filter(
      (e) => (e.payload as { quantity: number }).quantity < 10,
    );
    expect(events).toHaveLength(3);

    await consumer.project(events);

    expect(t.fake.stockWrites).toHaveLength(1);
    expect(written(t.fake.stockWrites[0])).toMatchObject({
      available: 7,
      change_from_quantity: 10,
    });
    expect((await links(t.id))[0].syncedStock).toBe(7);
  });

  // ---- AS-46 ---------------------------------------------------------------------------------------------------

  it('S08 AS-46: a deleted local product makes its links IGNORED; the provider later changing the variant resurrects nothing and pushes nothing', async () => {
    const t = await linked(10);
    const last = await latestEvent(t.productId);
    const deleted: EventEnvelope = {
      eventId: randomUUID(),
      type: 'catalog.product_deleted',
      version: 1,
      aggregateType: 'products',
      aggregateId: t.productId,
      aggregateVersion: last.aggregateVersion + 1,
      occurredAt: ctx.clock.now().toISOString(),
      payload: {
        productId: t.productId,
        shopId: t.shopId,
        productVersion: last.aggregateVersion + 1,
      },
    };

    await consumer.project([deleted]);
    const ignored = (await links(t.id))[0];
    expect(ignored.state).toBe('IGNORED');

    await consumer.project([{ ...deleted, eventId: randomUUID() }]);
    expect((await links(t.id))[0]).toEqual(ignored);

    ctx.clock.advance(MIN);
    t.fake.updateProduct(t.remote.id, { title: 'Changed at provider' });
    t.fake.setRemoteStock(t.variantId, 3);
    stockSpy.mockClear();
    expect(await engine.handle(incremental(t.id))).toBe('completed');

    expect(await productsOf(t.shopId)).toHaveLength(1);
    expect((await product(t.productId)).title).not.toContain(
      'Changed at provider',
    );
    expect((await product(t.productId)).quantity).toBe(10);
    expect(stockSpy).not.toHaveBeenCalled();
    expect(t.fake.stockWrites).toHaveLength(0);
    expect((await links(t.id))[0].state).toBe('IGNORED');
  });
});
