import { randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import { JobsService } from '@app/infrastructure/jobs';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import {
  IntegrationsModule,
  IntegrationsWorkerModule,
} from './integrations.module';
import { LinkApplyService } from './application/link-apply.service';
import { SyncEngineService } from './application/sync-engine.service';
import { serialiseCredentials } from './domain/credentials';
import { jitterMs, SYNC_INTERVAL_MS } from './domain/schedule';
import {
  CATALOG_GATEWAY,
  CREDENTIAL_VAULT,
  CURSOR_REPOSITORY,
  INTEGRATION_REPOSITORY,
  LINK_REPOSITORY,
  PROVIDER_SESSIONS,
  type CatalogGateway,
  type CredentialVault,
  type CursorRepository,
  type IntegrationRepository,
  type LinkRepository,
  type ProviderSessions,
  type SyncMessage,
} from './domain/ports';
import { TransactionRunner } from '@app/infrastructure/context';
import { CatalogServicesGateway } from './infra/catalog-gateway.adapter';
import { IntegrationsJobs } from './infra/integrations.jobs';
import {
  PROVIDER_NETWORK,
  type ProviderNetwork,
} from './infra/provider-network';
import { BackfillConsumer } from './infra/queue/backfill.consumer';
import { SyncConsumer } from './infra/queue/sync.consumer';
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

describe('Integration incremental sync', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let config: ApiConfigService;
  let engine: SyncEngineService;
  let apply: LinkApplyService;
  let integrations: IntegrationRepository;
  let cursors: CursorRepository;
  let vault: CredentialVault;
  let sessions: ProviderSessions;
  let jobs: IntegrationsJobs;
  let syncConsumer: SyncConsumer;
  let backfillConsumer: BackfillConsumer;
  let upsertSpy: jest.SpyInstance;
  let enqueue: jest.SpyInstance;
  let configSpy: jest.SpyInstance | undefined;
  const fakes: FakeShopify[] = [];
  const shopIds: string[] = [];
  const integrationIds: string[] = [];

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [IntegrationsModule, IntegrationsWorkerModule],
      overrides: [{ provide: PROVIDER_NETWORK, useValue: network }],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    config = ctx.app.get(ApiConfigService);
    // Everything under test lives in the worker module; the HTTP module only has to boot beside it.
    const worker = ctx.app.select(IntegrationsWorkerModule);
    engine = worker.get(SyncEngineService);
    apply = worker.get(LinkApplyService);
    integrations = worker.get(INTEGRATION_REPOSITORY);
    cursors = worker.get(CURSOR_REPOSITORY);
    vault = worker.get(CREDENTIAL_VAULT);
    sessions = worker.get(PROVIDER_SESSIONS);
    jobs = worker.get(IntegrationsJobs);
    syncConsumer = worker.get(SyncConsumer);
    backfillConsumer = worker.get(BackfillConsumer);
    upsertSpy = jest.spyOn(worker.get(CATALOG_GATEWAY), 'upsertItems');
    enqueue = jest
      .spyOn(ctx.app.get(TaskQueue), 'enqueue')
      .mockResolvedValue('m');
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    // The test environment sets a 3-page budget; the scenarios that are not about the budget run with the default.
    setting({ integration_sync_max_pages: 40 });
    enqueue.mockClear();
    upsertSpy.mockClear();
    resolver.reset();
    stores.clear();
  });

  afterEach(async () => {
    configSpy?.mockRestore();
    configSpy = undefined;
    for (const f of fakes.splice(0)) await f.stop();
    await db.query(
      `DROP TRIGGER IF EXISTS s08_fail_link_trg ON "ExternalLink"`,
    );
    await db.query(`DROP FUNCTION IF EXISTS s08_fail_link_fn()`);
    await db.query(`DROP SEQUENCE IF EXISTS s08_fail_link_seq`);
    if (integrationIds.length) {
      const replacements = { ids: integrationIds };
      for (const table of [
        'SyncRun',
        'SyncCursor',
        'ExternalLink',
        'SyncQuarantine',
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
    shopIds.length = 0;
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  /** Overrides settings the engine reads (run budgets); everything else is the real configuration. */
  function setting(values: Record<string, unknown>) {
    const original = config.get.bind(config) as (k: string) => unknown;
    configSpy?.mockRestore();
    configSpy = jest
      .spyOn(config, 'get')
      .mockImplementation(((key: string) =>
        key in values ? values[key] : original(key)) as never);
  }

  async function newShop() {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    shopIds.push(shop.id);
    return { shop, owner };
  }

  async function newStore(options: { pageSize?: number } = {}) {
    const domain = `sync-${randomUUID().slice(0, 8)}.myshopify.com`;
    const fake = new FakeShopify({
      shopDomain: domain,
      pageSize: options.pageSize ?? 2,
    });
    fake.now = () => ctx.clock.now();
    await fake.start();
    fakes.push(fake);
    stores.set(domain, fake.baseUrl);
    return { fake, domain };
  }

  /** A connected, ACTIVE integration of a fresh shop pointed at a fresh fake store. */
  async function world(
    options: { pageSize?: number; shopId?: string; ownerId?: string } = {},
  ) {
    const own = options.shopId
      ? { shop: { id: options.shopId }, owner: { id: options.ownerId! } }
      : await newShop();
    const { fake, domain } = await newStore(options);
    const id = await connect(own.shop.id, own.owner.id, fake, domain);
    return { shopId: own.shop.id, fake, domain, id };
  }

  async function connect(
    shopId: string,
    ownerId: string,
    fake: FakeShopify,
    domain: string,
  ) {
    const id = randomUUID();
    const result = await integrations.insertConnected({
      id,
      shopId,
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
      connectedBy: ownerId,
      now: ctx.clock.now(),
      maxPerShop: 5,
    });
    expect(result.kind).toBe('inserted');
    integrationIds.push(id);
    return id;
  }

  const backfillMsg = (integrationId: string): SyncMessage => ({
    integrationId,
    kind: 'backfill',
  });
  const incrementalMsg = (integrationId: string): SyncMessage => ({
    integrationId,
    kind: 'incremental',
  });

  const runs = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "SyncRun" WHERE "integrationId" = :integrationId ORDER BY "id"`,
      {
        type: QueryTypes.SELECT,
        replacements: { integrationId },
      },
    );

  const links = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "ExternalLink" WHERE "integrationId" = :integrationId ORDER BY "externalId"`,
      { type: QueryTypes.SELECT, replacements: { integrationId } },
    );

  const productsOf = (shopId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "Product" WHERE "shopId" = :shopId ORDER BY "externalSku"`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId },
      },
    );

  const productEvents = (productId: string, type: string) =>
    db.query(
      `SELECT * FROM "Outbox" WHERE "aggregateId" = :productId AND "type" = :type`,
      {
        type: QueryTypes.SELECT,
        replacements: { productId, type },
      },
    );

  const cursorOf = async (integrationId: string) =>
    (await cursors.read(integrationId, 'product'))!;

  const productListRequests = (fake: FakeShopify) =>
    fake.requestsTo('GET', /\/products\.json$/);

  const messagesTo = (queue: string, integrationId?: string) =>
    enqueue.mock.calls.filter(
      ([q, body]) =>
        q === queue &&
        (integrationId === undefined || body.integrationId === integrationId),
    );

  /** Seven variants of five visible products plus one draft (AS-12). */
  function seedSevenVariants(fake: FakeShopify) {
    const base = ctx.clock.now().getTime();
    const at = (minAgo: number) => new Date(base - minAgo * MIN);
    fake.addProduct({
      title: 'Mug',
      price: '19.99',
      stock: 5,
      extraVariants: [{ price: '21.50', stock: 6 }],
      updatedAt: at(50),
    });
    fake.addProduct({ title: 'Cap', price: '9', stock: 7, updatedAt: at(40) });
    fake.addProduct({
      title: 'Bag',
      price: '0.5',
      stock: 8,
      extraVariants: [{ price: '1.25', stock: 9 }],
      updatedAt: at(30),
    });
    fake.addProduct({
      title: 'Pen',
      price: '3.10',
      stock: 10,
      updatedAt: at(20),
    });
    fake.addProduct({
      title: 'Hat',
      price: '12.00',
      stock: 11,
      updatedAt: at(10),
    });
    fake.addProduct({
      title: 'Draft thing',
      status: 'draft',
      stock: 3,
      updatedAt: at(5),
    });
    return at(10);
  }

  // ---- AS-12 / AS-13 -------------------------------------------------------------------------------------------

  it('S08 AS-12: a backfill with page size 2 imports 7 variants through the catalog command, links them and sets the watermark to the largest fetched updatedAt', async () => {
    const { shopId, fake, id } = await world({ pageSize: 2 });
    const newest = seedSevenVariants(fake);

    const outcome = await engine.handle(backfillMsg(id));

    expect(outcome).toBe('completed');
    expect(upsertSpy.mock.calls.length).toBeGreaterThan(0);
    for (const [shop, items, source] of upsertSpy.mock.calls) {
      expect(shop).toBe(shopId);
      expect(source).toBe('shopify');
      expect(items.length).toBeLessThanOrEqual(500);
    }

    const products = await productsOf(shopId);
    expect(products).toHaveLength(7);
    const stockBySku = new Map(
      products.map((p) => [p.externalSku, p.quantity]),
    );
    const rows = await links(id);
    expect(rows).toHaveLength(7);
    const expectedStock = [5, 6, 7, 8, 9, 10, 11];
    for (const link of rows) {
      expect(link.externalId).toMatch(/^\d+:\d+$/);
      const sku = `shopify:${id}:${link.externalId}`;
      expect(stockBySku.has(sku)).toBe(true);
      expect(link.state).toBe('ACTIVE');
      expect(link.contentDigest).toMatch(/^[0-9a-f]{16,}$/);
      expect(link.syncedStock).toBe(stockBySku.get(sku));
      expect(link.localId).toBe(
        products.find((p) => p.externalSku === sku)!.id,
      );
      expect(link.remoteUpdatedAt).not.toBeNull();
      expect(link.raw).toEqual(
        expect.objectContaining({ id: expect.any(Number) }),
      );
    }
    expect(rows.map((l) => l.syncedStock).sort((a, b) => a - b)).toEqual(
      expectedStock,
    );
    expect(products.map((p) => p.quantity).sort((a, b) => a - b)).toEqual(
      expectedStock,
    );

    const cursor = await cursorOf(id);
    expect(cursor.watermark?.toISOString()).toBe(newest.toISOString());
    expect(cursor.pageCursor).toBeNull();

    const recorded = await runs(id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      kind: 'backfill',
      outcome: 'completed',
      counters: {
        fetched: 7,
        created: 7,
        updated: 0,
        unchanged: 0,
        quarantined: 0,
      },
    });
    expect(messagesTo('integration-sync')).toHaveLength(0);
    expect(fake.stockWrites).toHaveLength(0);
  });

  it('S08 AS-13: the same backfill again reports 7 unchanged, writes no catalog row or event and duplicates nothing', async () => {
    const { shopId, fake, id } = await world({ pageSize: 2 });
    seedSevenVariants(fake);
    await engine.handle(backfillMsg(id));
    const before = await productsOf(shopId);
    const linksBefore = await links(id);
    upsertSpy.mockClear();

    expect(await engine.handle(backfillMsg(id))).toBe('completed');

    expect(upsertSpy).not.toHaveBeenCalled();
    const recorded = await runs(id);
    expect(recorded[1]).toMatchObject({
      outcome: 'completed',
      counters: {
        fetched: 7,
        created: 0,
        updated: 0,
        unchanged: 7,
        quarantined: 0,
      },
    });
    const after = await productsOf(shopId);
    expect(after.map((p) => [p.id, p.version, Number(p.updatedAt)])).toEqual(
      before.map((p) => [p.id, p.version, Number(p.updatedAt)]),
    );
    for (const p of after)
      expect(await productEvents(p.id, 'catalog.product_updated')).toHaveLength(
        0,
      );
    expect(
      (await links(id)).map((l) => [
        l.externalId,
        l.contentDigest,
        l.syncedStock,
      ]),
    ).toEqual(
      linksBefore.map((l) => [l.externalId, l.contentDigest, l.syncedStock]),
    );
  });

  it('S08 AS-13: an existing product keeps S05 quantity semantics (absolute stock is only sent for an unlinked item)', async () => {
    const { fake, id } = await world({ pageSize: 2 });
    const product = fake.addProduct({ title: 'Mug', stock: 5 });
    await engine.handle(backfillMsg(id));
    expect(upsertSpy.mock.calls[0][1][0]).toHaveProperty('quantity', 5);

    fake.updateProduct(product.id, { title: 'Mug v2' });
    upsertSpy.mockClear();
    await engine.handle(incrementalMsg(id));

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const sent = upsertSpy.mock.calls[0][1][0];
    expect(sent).toMatchObject({ title: expect.stringContaining('Mug v2') });
    expect(sent).not.toHaveProperty('quantity');
    expect(sent).toHaveProperty('priceMinor');
  });

  it('S08 AS-12: a shop that is not active is skipped with a run record, no provider call and no product', async () => {
    const { shopId, fake, id } = await world({ pageSize: 2 });
    fake.addProduct({ title: 'Mug', stock: 1 });
    await tenancy.setShopStatus(shopId, 'SUSPENDED');

    expect(await engine.handle(backfillMsg(id))).toBe(
      'skipped_shop_not_active',
    );

    expect(fake.requests).toHaveLength(0);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect((await runs(id)).map((r) => r.outcome)).toEqual([
      'skipped_shop_not_active',
    ]);
    expect(await productsOf(shopId)).toHaveLength(0);
  });

  // ---- AS-16 ---------------------------------------------------------------------------------------------------

  it('S08 AS-16: an incremental run asks since exactly W - 5 minutes, applies the changed item, finds the near-boundary item unchanged and a second run applies nothing', async () => {
    const { shopId, fake, id } = await world({ pageSize: 10 });
    const now = ctx.clock.now().getTime();
    const W = new Date(now - 30 * MIN);
    fake.addProduct({
      title: 'Old',
      stock: 1,
      updatedAt: new Date(now - 120 * MIN),
    });
    const near = fake.addProduct({
      title: 'Near',
      stock: 2,
      updatedAt: new Date(W.getTime() - 3 * MIN),
    });
    const anchor = fake.addProduct({ title: 'Anchor', stock: 3, updatedAt: W });
    await engine.handle(backfillMsg(id));
    expect((await cursorOf(id)).watermark?.toISOString()).toBe(W.toISOString());

    fake.now = () => new Date(W.getTime() + MIN);
    fake.updateProduct(anchor.id, { title: 'Anchor v2' });
    fake.now = () => ctx.clock.now();
    fake.clearLog();
    upsertSpy.mockClear();

    expect(await engine.handle(incrementalMsg(id))).toBe('completed');

    const asked = productListRequests(fake);
    expect(asked).toHaveLength(1);
    expect(asked[0].query.updated_at_min).toBe(
      new Date(W.getTime() - 5 * MIN).toISOString(),
    );
    const recorded = await runs(id);
    expect(recorded[1]).toMatchObject({
      kind: 'incremental',
      outcome: 'completed',
      counters: { fetched: 2, created: 0, updated: 1, unchanged: 1 },
    });
    const wNew = new Date(W.getTime() + MIN);
    expect((await cursorOf(id)).watermark?.toISOString()).toBe(
      wNew.toISOString(),
    );
    expect(
      (await productsOf(shopId)).find((p) => p.title.includes('Anchor'))!.title,
    ).toContain('Anchor v2');
    expect(
      (await productsOf(shopId)).find((p) => p.title.includes('Near')),
    ).toBeDefined();
    void near;

    fake.clearLog();
    upsertSpy.mockClear();
    expect(await engine.handle(incrementalMsg(id))).toBe('completed');
    expect(productListRequests(fake)[0].query.updated_at_min).toBe(
      new Date(wNew.getTime() - 5 * MIN).toISOString(),
    );
    expect(upsertSpy).not.toHaveBeenCalled();
    expect((await runs(id))[2].counters).toMatchObject({
      updated: 0,
      created: 0,
      unchanged: 2,
    });
    expect((await cursorOf(id)).watermark?.toISOString()).toBe(
      wNew.toISOString(),
    );
  });

  // ---- AS-17 ---------------------------------------------------------------------------------------------------

  it('S08 AS-17: a run that dies after page 3 resumes at page 4, moves the watermark only at the end and keeps the largest updatedAt of the earlier pages', async () => {
    const { fake, id } = await world({ pageSize: 2 });
    const now = ctx.clock.now().getTime();
    // 9 products = 5 pages; the newest one is on page 1, so a watermark computed from pages 4-5 alone would be wrong.
    const newest = new Date(now - 2 * MIN);
    for (let i = 0; i < 9; i++)
      fake.addProduct({
        title: `P${i}`,
        stock: i,
        updatedAt: i === 0 ? newest : new Date(now - (100 - i) * MIN),
      });

    // The provider drops the connection on page 4 (the third request that carries a page cursor, and its retries).
    let cursorRequests = 0;
    fake.inject({
      match: (r) =>
        r.path.endsWith('/products.json') &&
        !!r.query.page_info &&
        ++cursorRequests >= 3,
      fault: { kind: 'drop' },
    });
    const first = await engine
      .handle(backfillMsg(id))
      .catch((e) => `threw:${(e as Error).message}`);
    expect(first).toBe('failed');
    const afterCrash = await cursorOf(id);
    expect(afterCrash.watermark).toBeNull();
    expect(afterCrash.pageCursor).not.toBeNull();
    expect(await links(id)).toHaveLength(6);

    fake.clearFaults();
    fake.clearLog();
    expect(await engine.handle(backfillMsg(id))).toBe('completed');

    const resumed = productListRequests(fake);
    expect(resumed).toHaveLength(2); // pages 4 and 5; pages 1-3 are not asked again
    const stored = Buffer.from(
      resumed[0].query.page_info,
      'base64url',
    ).toString('utf8');
    expect(JSON.parse(stored).afterId).toBeGreaterThan(0);
    expect(await links(id)).toHaveLength(9);
    const recorded = await runs(id);
    expect(recorded.map((r) => r.outcome)).toEqual(['failed', 'completed']);
    expect(recorded[0].counters.fetched + recorded[1].counters.fetched).toBe(9);
    const done = await cursorOf(id);
    expect(done.watermark?.toISOString()).toBe(newest.toISOString());
    expect(done.pageCursor).toBeNull();
  });

  it('S08 AS-17: an item dated in the future is applied but the watermark never exceeds the frozen now', async () => {
    const { shopId, fake, id } = await world({ pageSize: 10 });
    const now = ctx.clock.now();
    fake.addProduct({
      title: 'Past',
      stock: 1,
      updatedAt: new Date(now.getTime() - 10 * MIN),
    });
    fake.addProduct({
      title: 'Future',
      stock: 2,
      updatedAt: new Date(now.getTime() + 24 * 60 * MIN),
    });

    expect(await engine.handle(backfillMsg(id))).toBe('completed');

    expect(await productsOf(shopId)).toHaveLength(2);
    expect((await cursorOf(id)).watermark?.toISOString()).toBe(
      now.toISOString(),
    );
  });

  // ---- AS-18 ---------------------------------------------------------------------------------------------------

  it('S08 AS-18: two messages handled at the same moment run once; the other ends skipped_locked without calling the provider', async () => {
    const { fake, id } = await world({ pageSize: 10 });
    fake.addProduct({ title: 'A', stock: 1 });
    fake.addProduct({ title: 'B', stock: 2 });
    fake.inject({
      match: (r) => r.path.endsWith('/products.json'),
      fault: { kind: 'delay', ms: 200 },
    });

    const outcomes = await Promise.all([
      engine.handle(incrementalMsg(id)),
      engine.handle(incrementalMsg(id)),
    ]);

    expect([...outcomes].sort()).toEqual(['completed', 'skipped_locked']);
    expect(productListRequests(fake)).toHaveLength(1);
    const recorded = await runs(id);
    expect(recorded.map((r) => r.outcome).sort()).toEqual([
      'completed',
      'skipped_locked',
    ]);
    expect(await links(id)).toHaveLength(2);
  });

  it('S08 AS-18: once the clock passes the lease a stalled holder is fenced out and the watermark never moves backwards', async () => {
    const { fake, id } = await world({ pageSize: 10 });
    const now = ctx.clock.now().getTime();
    fake.addProduct({
      title: 'A',
      stock: 1,
      updatedAt: new Date(now - 20 * MIN),
    });
    const gate = fake.gate((r) => r.path.endsWith('/products.json'), {
      once: true,
    });

    const stalled = engine.handle(incrementalMsg(id));
    await gate.reached;
    const fenceBefore = (await cursorOf(id)).fence;
    ctx.clock.advance(6 * MIN); // lease TTL is 5 minutes

    expect(await engine.handle(incrementalMsg(id))).toBe('completed');
    const watermark = (await cursorOf(id)).watermark!;
    expect((await cursorOf(id)).fence).toBe(fenceBefore + 1);

    gate.release();
    expect(await stalled).toBe('failed');

    const recorded = await runs(id);
    expect(recorded.find((r) => r.outcome === 'failed')!.detail).toBe(
      'lease_lost',
    );
    const after = await cursorOf(id);
    expect(after.watermark!.getTime()).toBeGreaterThanOrEqual(
      watermark.getTime(),
    );
    expect(after.watermark!.toISOString()).toBe(watermark.toISOString());
    // The stalled holder's late writes must not have touched the cursor (the new holder released it cleanly).
    expect(after.leaseHolder).toBeNull();
  });

  // ---- AS-19 ---------------------------------------------------------------------------------------------------

  it('S08 AS-19: a 3-page budget over 12 pages yields with exactly one continuation message each time and the chain finishes', async () => {
    const { fake, id } = await world({ pageSize: 2 });
    for (let i = 0; i < 24; i++) fake.addProduct({ title: `P${i}`, stock: i });
    setting({ integration_sync_max_pages: 3 });

    expect(await engine.handle(backfillMsg(id))).toBe('yielded');
    expect(messagesTo('integration-backfill', id)).toHaveLength(1);
    expect(messagesTo('integration-backfill', id)[0][1]).toEqual(
      backfillMsg(id),
    );
    expect(await links(id)).toHaveLength(6);
    const mid = await cursorOf(id);
    expect(mid.pageCursor).not.toBeNull();
    expect(mid.watermark).toBeNull();

    let outcome: string = 'yielded';
    let guard = 0;
    while (outcome === 'yielded' && guard++ < 10) {
      enqueue.mockClear();
      outcome = await engine.handle(backfillMsg(id));
      expect(messagesTo('integration-backfill', id)).toHaveLength(
        outcome === 'yielded' ? 1 : 0,
      );
    }
    expect(outcome).toBe('completed');
    expect(await links(id)).toHaveLength(24);
    expect((await runs(id)).map((r) => r.outcome)).toEqual([
      'yielded',
      'yielded',
      'yielded',
      'completed',
    ]);
    expect((await cursorOf(id)).watermark).not.toBeNull();
  });

  it.each([
    ['incremental', 4 * MIN, 'integration-sync'],
    ['backfill', 12 * MIN, 'integration-backfill'],
  ] as const)(
    'S08 AS-19: the %s time budget ends the run with a continuation when the clock passes it',
    async (kind, budget, queue) => {
      const { fake, id } = await world({ pageSize: 2 });
      for (let i = 0; i < 8; i++) fake.addProduct({ title: `P${i}`, stock: i });
      const gate = fake.gate(
        (r) => r.path.endsWith('/products.json') && !!r.query.page_info,
        { once: true },
      );

      const running = engine.handle({ integrationId: id, kind });
      await gate.reached; // page 2 is requested after page 1 was applied
      ctx.clock.advance(budget + MIN);
      gate.release();

      expect(await running).toBe('yielded');
      expect(messagesTo(queue, id)[0][1]).toEqual({ integrationId: id, kind });
      expect(messagesTo(queue, id)).toHaveLength(1);
      expect(await links(id)).toHaveLength(4);
      expect((await cursorOf(id)).watermark).toBeNull();
    },
  );

  // ---- AS-20 ---------------------------------------------------------------------------------------------------

  it('S08 AS-20: the scheduled pull enqueues exactly the due, active, healthy integrations once and moves their next-due time by 5 minutes plus a deterministic jitter', async () => {
    const { shop, owner } = await newShop();
    const make = async (shopId = shop.id) => {
      const { fake, domain } = await newStore();
      return connect(shopId, owner.id, fake, domain);
    };
    const due = [await make(), await make(), await make()];
    const second = await newShop(); // the per-shop limit is 5
    const paused = await make(second.shop.id);
    const reauth = await make(second.shop.id);
    const disconnected = await make(second.shop.id);
    const other = await newShop();
    const inSuspendedShop = await make(other.shop.id);
    const breakerOpen = await make();
    const at = ctx.clock.now();
    const options = { reason: 'test', actorId: null, now: at };
    await integrations.transition(paused, 'ACTIVE', 'PAUSED', {
      ...options,
      pausedReason: 'seller',
    });
    await integrations.transition(reauth, 'ACTIVE', 'NEEDS_REAUTH', options);
    await integrations.transition(disconnected, 'ACTIVE', 'DISCONNECTED', {
      ...options,
      eraseCredentials: true,
    });
    await tenancy.setShopStatus(other.shop.id, 'SUSPENDED');
    await integrations.saveBreaker(breakerOpen, {
      failures: 5,
      openUntil: new Date(at.getTime() + 5 * MIN),
      halfOpen: false,
      attentionRaised: false,
    });
    const mine = new Set([
      ...due,
      paused,
      reauth,
      disconnected,
      inSuspendedShop,
      breakerOpen,
    ]);

    await jobs.syncAll();

    const sent = enqueue.mock.calls.filter(
      ([q, body]) => q === 'integration-sync' && mine.has(body.integrationId),
    );
    expect(
      sent
        .map(([, body]) => body)
        .sort((a, b) => a.integrationId.localeCompare(b.integrationId)),
    ).toEqual(
      [...due]
        .sort()
        .map((integrationId) => ({ integrationId, kind: 'incremental' })),
    );
    for (const integrationId of due) {
      const row = (await integrations.findById(integrationId))!;
      const jitter = jitterMs(integrationId);
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(60_000);
      expect(row.nextSyncAt!.getTime()).toBe(
        at.getTime() + SYNC_INTERVAL_MS + jitter,
      );
    }
    expect(new Set(due.map(jitterMs)).size).toBeGreaterThan(1);

    enqueue.mockClear();
    await jobs.syncAll();
    expect(
      enqueue.mock.calls.filter(
        ([q, body]) =>
          q === 'integration-sync' && due.includes(body.integrationId),
      ),
    ).toHaveLength(0);
  });

  it('S08 AS-20: the jobs are declared and scheduled under their catalog-sync names and the renamed schedules are removed', async () => {
    const service = ctx.app.get(JobsService);
    await service.upsertSchedule({
      name: 'integrations.sync-all',
      cron: '0 */5 * * * *',
      jobType: 'catalog-sync.sync-all',
      payload: {},
    });
    await service.upsertSchedule({
      name: 'integrations.reconcile-all',
      cron: '0 0 4 * * *',
      jobType: 'catalog-sync.reconcile-all',
      payload: {},
    });
    await jobs.onApplicationBootstrap();

    const names = (
      await db.query<{ name: string }>(
        `SELECT "name" FROM "JobSchedule" WHERE "name" LIKE '%sync-all' OR "name" LIKE '%reconcile-all' OR "name" LIKE '%purge-integration-data'`,
        {
          type: QueryTypes.SELECT,
        },
      )
    ).map((r) => r.name);
    expect(names.sort()).toEqual([
      'catalog-sync.purge-integration-data',
      'catalog-sync.reconcile-all',
      'catalog-sync.sync-all',
    ]);
    const schedules = await db.query<Record<string, any>>(
      `SELECT "name", "cron" FROM "JobSchedule" WHERE "name" LIKE 'catalog-sync.%'`,
      { type: QueryTypes.SELECT },
    );
    expect(
      schedules.find((s) => s.name === 'catalog-sync.sync-all')!.cron,
    ).toBe('0 */5 * * * *');
    expect(
      schedules.find((s) => s.name === 'catalog-sync.reconcile-all')!.cron,
    ).toBe('0 40 3 * * *');
  });

  // ---- AS-21 ---------------------------------------------------------------------------------------------------

  it('S08 AS-21: a backfill held mid-run does not delay another shop incremental pull; the queues have their own names and concurrency', async () => {
    const a = await world({ pageSize: 2 });
    const b = await world({ pageSize: 2 });
    for (let i = 0; i < 6; i++) a.fake.addProduct({ title: `A${i}`, stock: i });
    b.fake.addProduct({ title: 'B', stock: 1 });
    const gate = a.fake.gate(
      (r) => r.path.endsWith('/products.json') && !!r.query.page_info,
      { once: true },
    );

    const slow = backfillConsumer.handle({ body: backfillMsg(a.id) });
    await gate.reached;
    await syncConsumer.handle({ body: incrementalMsg(b.id) });

    expect((await runs(b.id))[0]).toMatchObject({
      outcome: 'completed',
      kind: 'incremental',
    });
    expect(gate.waiting).toBe(true);
    gate.release();
    await slow;
    expect((await runs(a.id))[0].outcome).toBe('completed');

    const props = (c: unknown) =>
      c as {
        queueName: string;
        concurrency: number;
        visibilityTimeoutSec: number;
      };
    expect([
      props(syncConsumer).queueName,
      props(syncConsumer).concurrency,
      props(syncConsumer).visibilityTimeoutSec,
    ]).toEqual(['integration-sync', 20, 300]);
    expect([
      props(backfillConsumer).queueName,
      props(backfillConsumer).concurrency,
      props(backfillConsumer).visibilityTimeoutSec,
    ]).toEqual(['integration-backfill', 4, 900]);
  });

  // ---- AS-22 / AS-23 / AS-24 -----------------------------------------------------------------------------------

  it('S08 AS-22: an older snapshot of an applied variant is skipped as stale with no catalog call and nothing changed', async () => {
    const { shopId, fake, id } = await world({ pageSize: 10 });
    const t2 = new Date(ctx.clock.now().getTime() - 10 * MIN);
    const t1 = new Date(t2.getTime() - 60 * MIN);
    const product = fake.addProduct({ title: 'Mug', stock: 4, updatedAt: t2 });
    await engine.handle(backfillMsg(id));
    const before = await productsOf(shopId);
    const linkBefore = (await links(id))[0];
    upsertSpy.mockClear();

    fake.malform(product.id, {
      title: 'Delayed old title',
      updated_at: t1.toISOString(),
      variants: product.variants.map((v) => ({
        ...v,
        updated_at: t1.toISOString(),
      })),
    });
    expect(await engine.handle(backfillMsg(id))).toBe('completed');

    expect(upsertSpy).not.toHaveBeenCalled();
    expect((await runs(id))[1].counters).toMatchObject({
      fetched: 1,
      stale: 1,
      updated: 0,
      created: 0,
      unchanged: 0,
    });
    const after = await productsOf(shopId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      title: before[0].title,
      quantity: before[0].quantity,
      version: before[0].version,
    });
    const linkAfter = (await links(id))[0];
    expect(linkAfter.contentDigest).toBe(linkBefore.contentDigest);
    expect(new Date(linkAfter.remoteUpdatedAt).toISOString()).toBe(
      t2.toISOString(),
    );
  });

  it('S08 AS-23: a webhook-style fetch and a page applying the same change at the same moment give one updated and one unchanged, one version step and one event', async () => {
    const { shopId, fake, id } = await world({ pageSize: 10 });
    const product = fake.addProduct({ title: 'Mug', stock: 4 });
    await engine.handle(backfillMsg(id));
    const [base] = await productsOf(shopId);
    fake.updateProduct(product.id, { title: 'Mug renamed' });

    const record = (await integrations.findById(id))!;
    const raw = await sessions
      .provider('shopify')
      .fetchOne(
        sessions.forIntegration(record),
        `${product.id}:${product.variants[0].id}`,
      );
    expect(raw).not.toBeNull();
    const [page, fetched] = await Promise.all([
      engine.handle(incrementalMsg(id)),
      apply.applyItems(record, [raw!]),
    ]);

    expect(page).toBe('completed');
    expect(fetched.kind).toBe('applied');
    const pageCounters = (await runs(id))[1].counters;
    const fetchedCounters = fetched.counters;
    expect(pageCounters.updated + fetchedCounters.updated).toBe(1);
    expect(pageCounters.unchanged + fetchedCounters.unchanged).toBe(1);
    const [after] = await productsOf(shopId);
    expect(after.version).toBe(base.version + 1);
    expect(after.title).toContain('Mug renamed');
    expect(
      await productEvents(after.id, 'catalog.product_updated'),
    ).toHaveLength(1);
  });

  it('S08 AS-24: a link write that fails once is repaired by the retry: one product, one link, stock not doubled', async () => {
    const { shopId, fake, id } = await world({ pageSize: 10 });
    fake.addProduct({ title: 'Mug', stock: 5 });
    await db.query(`CREATE SEQUENCE s08_fail_link_seq`);
    await db.query(`
      CREATE FUNCTION s08_fail_link_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW."integrationId" = '${id}' AND nextval('s08_fail_link_seq') = 1 THEN
          RAISE EXCEPTION 's08 forced link write failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await db.query(
      `CREATE TRIGGER s08_fail_link_trg BEFORE INSERT ON "ExternalLink" FOR EACH ROW EXECUTE FUNCTION s08_fail_link_fn()`,
    );

    await expect(engine.handle(backfillMsg(id))).rejects.toThrow(
      /forced link write failure/,
    );
    expect(await links(id)).toHaveLength(0);
    expect((await productsOf(shopId)).map((p) => p.quantity)).toEqual([5]);

    expect(await engine.handle(backfillMsg(id))).toBe('completed');

    const products = await productsOf(shopId);
    expect(products).toHaveLength(1);
    expect(products[0].quantity).toBe(5);
    const rows = await links(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ localId: products[0].id, syncedStock: 5 });
    expect((await runs(id)).map((r) => r.outcome)).toEqual([
      'failed',
      'completed',
    ]);
  });

  // ---- apply lock (T022: first-time applies of one external id do not race) -------------------------------------

  it('S08 AS-23: a first-time apply waits for the per-(integration, externalId) lock held by another transaction', async () => {
    const { fake, id } = await world({ pageSize: 10 });
    const remote = fake.addProduct({ title: 'Mug', stock: 5 });
    const externalId = `${remote.id}:${remote.variants[0].id}`;
    const record = (await integrations.findById(id))!;
    const raw = await sessions
      .provider('shopify')
      .fetchOne(sessions.forIntegration(record), externalId);
    const linkRepo = ctx.app
      .select(IntegrationsWorkerModule)
      .get(LINK_REPOSITORY) as LinkRepository;
    const transactions = ctx.app
      .select(IntegrationsWorkerModule)
      .get(TransactionRunner);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = transactions.run(async () => {
      await linkRepo.lockApply(id, [externalId]);
      locked();
      await held;
    });
    await lockTaken;

    let finished = false;
    const applying = apply.applyItems(record, [raw!]).then((r) => {
      finished = true;
      return r;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false);
    } finally {
      release();
    }
    await holder;
    expect((await applying).kind).toBe('applied');
    expect(await links(id)).toHaveLength(1);
  });

  it("S08 AS-23: when another writer linked the variant while the catalog call ran, the first-time apply keeps that link's agreed stock", async () => {
    const { shopId, fake, id } = await world({ pageSize: 10 });
    const remote = fake.addProduct({ title: 'Mug', stock: 5 });
    const externalId = `${remote.id}:${remote.variants[0].id}`;
    const record = (await integrations.findById(id))!;
    const raw = await sessions
      .provider('shopify')
      .fetchOne(sessions.forIntegration(record), externalId);
    const linkRepo = ctx.app
      .select(IntegrationsWorkerModule)
      .get(LINK_REPOSITORY) as LinkRepository;
    const gateway = ctx.app
      .select(IntegrationsWorkerModule)
      .get(CATALOG_GATEWAY);
    upsertSpy.mockImplementationOnce(
      async (...args: Parameters<CatalogGateway['upsertItems']>) => {
        const outcome =
          await CatalogServicesGateway.prototype.upsertItems.apply(
            gateway,
            args,
          );
        // The competing applier (a webhook fetch) wins the race: its link exists, and its stock has since been merged to 99.
        const created = (outcome as Extract<typeof outcome, { kind: 'ok' }>)
          .results[0];
        await linkRepo.upsertApplied({
          integrationId: id,
          shopId,
          entity: 'product',
          externalId,
          localId: created.productId,
          contentDigest: 'competitor',
          syncedStock: 99,
          remoteUpdatedAt: new Date(ctx.clock.now().getTime() + 1000),
          raw: {},
        });
        return outcome;
      },
    );

    await apply.applyItems(record, [raw!]);

    const rows = await links(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].syncedStock).toBe(99);
  });

  // ---- AS-25 ---------------------------------------------------------------------------------------------------

  it('S08 AS-25: duplicate incremental and one deliveries change nothing the second time', async () => {
    const { shopId, fake, id } = await world({ pageSize: 10 });
    const product = fake.addProduct({ title: 'Mug', stock: 4 });
    const externalId = `${product.id}:${product.variants[0].id}`;
    const one: SyncMessage = { integrationId: id, kind: 'one', externalId };

    await syncConsumer.handle({ body: one });
    const first = await productsOf(shopId);
    expect(first).toHaveLength(1);
    expect(await links(id)).toHaveLength(1);
    await syncConsumer.handle({ body: one });
    const second = await productsOf(shopId);
    expect(second.map((p) => [p.id, p.version, p.quantity])).toEqual(
      first.map((p) => [p.id, p.version, p.quantity]),
    );
    expect(await links(id)).toHaveLength(1);

    await syncConsumer.handle({ body: incrementalMsg(id) });
    await syncConsumer.handle({ body: incrementalMsg(id) });
    const runList = await runs(id);
    const last = runList[runList.length - 1];
    expect(last.counters).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 1,
    });
    expect((await productsOf(shopId))[0].version).toBe(first[0].version);
  });

  it.each([
    ['not a UUID', { integrationId: 'nope', kind: 'incremental' }],
    ['unknown kind', { integrationId: randomUUID(), kind: 'explode' }],
    [
      'extra field',
      { integrationId: randomUUID(), kind: 'incremental', force: true },
    ],
    [
      'empty externalId',
      { integrationId: randomUUID(), kind: 'one', externalId: '' },
    ],
    [
      'backfill on the incremental queue',
      { integrationId: randomUUID(), kind: 'backfill' },
    ],
    ['no body', null],
  ])(
    'S08 AS-25: an invalid message (%s) is rejected without side effects',
    async (_name, body) => {
      const before = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "SyncRun"`,
        { type: QueryTypes.SELECT },
      );
      await expect(syncConsumer.handle({ body })).rejects.toThrow();
      // The queue adapter dead-letters on exactly this schema.
      expect(
        (
          syncConsumer as unknown as {
            bodySchema: { safeParse(v: unknown): { success: boolean } };
          }
        ).bodySchema.safeParse(body).success,
      ).toBe(false);
      const after = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "SyncRun"`,
        { type: QueryTypes.SELECT },
      );
      expect(after[0].n).toBe(before[0].n);
    },
  );

  it('S08 AS-25: a message for an unknown or disconnected integration is acknowledged and does nothing', async () => {
    const { fake, id } = await world();
    fake.addProduct({ title: 'Mug', stock: 1 });
    await expect(
      syncConsumer.handle({ body: incrementalMsg(randomUUID()) }),
    ).resolves.toBeUndefined();

    await integrations.transition(id, 'ACTIVE', 'DISCONNECTED', {
      reason: 'test',
      actorId: null,
      now: ctx.clock.now(),
      eraseCredentials: true,
    });
    fake.clearLog();
    await expect(
      syncConsumer.handle({ body: incrementalMsg(id) }),
    ).resolves.toBeUndefined();
    await expect(
      backfillConsumer.handle({ body: backfillMsg(id) }),
    ).resolves.toBeUndefined();

    expect(fake.requests).toHaveLength(0);
    expect(await runs(id)).toHaveLength(0);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
