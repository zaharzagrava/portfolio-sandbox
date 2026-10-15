import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import {
  syncPushResponseSchema,
  type SyncOpResult,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  ProductCommandService,
  ProductQueryService,
  ProductStockService,
} from '@app/domains/catalog';
import { ShopDeleted } from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { productEvents } from '@app/test/utils/catalog-fixtures';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';
import {
  OfflineSyncModule,
  OfflineSyncProjectorModule,
  OfflineSyncWorkerModule,
} from './sync.module';
import { SyncLifecycleService } from './application/sync-lifecycle.service';
import { OFFLINE_METRIC_NAMES } from './application/offline-sync-metrics';
import { encodeHlc } from './domain/hlc';
import { fingerprint, parseOp } from './domain/sync-ops';
import {
  SYNC_CONFLICT_REPOSITORY,
  SYNC_FEED_REPOSITORY,
  SYNC_OPERATION_REPOSITORY,
  type SyncConflictRepository,
  type SyncFeedRepository,
  type SyncOperationRepository,
} from './domain/ports';
import { SyncFeedConsumer } from './infra/sync-feed.consumer';
import {
  OfflineProductDeletedConsumer,
  OfflineShopDeletedConsumer,
} from './infra/sync-lifecycle.consumers';
import { OfflineSyncJobs } from './infra/offline-sync.jobs';

const SECOND = 1_000;
const DAY = 86_400_000;

describe('Offline sync: lifecycle jobs and observability', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let commands: ProductCommandService;
  let query: ProductQueryService;
  let stockService: ProductStockService;
  let lifecycle: SyncLifecycleService;
  let operations: SyncOperationRepository;
  let feed: SyncFeedRepository;
  let conflicts: SyncConflictRepository;
  let feedConsumer: SyncFeedConsumer;
  let shopDeleted: OfflineShopDeletedConsumer;
  let productDeleted: OfflineProductDeletedConsumer;
  let jobs: OfflineSyncJobs;
  let logical = 0;
  const logSpies: jest.SpyInstance[] = [];

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [
        OfflineSyncModule,
        OfflineSyncWorkerModule,
        OfflineSyncProjectorModule,
      ],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    commands = ctx.app.get(ProductCommandService);
    query = ctx.app.get(ProductQueryService);
    stockService = ctx.app.get(ProductStockService);
    lifecycle = ctx.app.get(SyncLifecycleService, { strict: false });
    operations = ctx.app.get(SYNC_OPERATION_REPOSITORY, { strict: false });
    feed = ctx.app.get(SYNC_FEED_REPOSITORY, { strict: false });
    conflicts = ctx.app.get(SYNC_CONFLICT_REPOSITORY, { strict: false });
    const projector = ctx.app.select(OfflineSyncProjectorModule);
    feedConsumer = projector.get(SyncFeedConsumer);
    shopDeleted = projector.get(OfflineShopDeletedConsumer);
    productDeleted = projector.get(OfflineProductDeletedConsumer);
    jobs = ctx.app.select(OfflineSyncWorkerModule).get(OfflineSyncJobs);
  });

  afterAll(async () => {
    await ctx.close();
  });

  afterEach(() => {
    for (const spy of logSpies.splice(0)) spy.mockRestore();
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  async function world() {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    return { owner, shopId: shop.id };
  }
  type World = { owner: TestUser; shopId: string };

  async function product(w: World, quantity = 10) {
    return commands.create(w.shopId, w.owner.id, {
      title: 'Secret Mug Title',
      description: 'Secret description text',
      brand: 'Acme',
      category: 'home',
      priceMinor: 1_000,
      quantity,
    });
  }

  const hlc = (node = 'dev-a', offsetMs = 0) =>
    encodeHlc({
      physical: ctx.clock.now().getTime() + offsetMs,
      logical: ++logical,
      node,
    });

  const adjust = (productId: string, delta: number) => ({
    type: 'stock.adjust',
    opId: uuidv7(),
    hlc: hlc(),
    productId,
    delta,
    reason: delta > 0 ? 'received' : 'sold',
  });
  const titleEdit = (productId: string, title: string, offsetMs = 0) => ({
    type: 'product.update',
    opId: uuidv7(),
    hlc: hlc('dev-a', offsetMs),
    productId,
    fields: { title },
  });

  const push = (w: World, ops: unknown[], device = 'dev-a') =>
    ctx
      .as(w.owner)
      .post(`/api/shops/${w.shopId}/sync/push`)
      .set('X-Device-Id', device)
      .send({ ops });

  async function pushOk(w: World, ops: unknown[], device = 'dev-a') {
    const res = await push(w, ops, device);
    expect(res.status).toBe(200);
    return syncPushResponseSchema.parse(res.body).results;
  }

  const count = async (table: string, shopId: string) =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM "${table}" WHERE "shopId" = :shopId`,
          { type: QueryTypes.SELECT, replacements: { shopId } },
        )
      )[0].n,
    );
  const counts = async (shopId: string) => ({
    SyncOperation: await count('SyncOperation', shopId),
    SyncConflict: await count('SyncConflict', shopId),
    ShopChangeLog: await count('ShopChangeLog', shopId),
    ShopSyncState: await count('ShopSyncState', shopId),
    ProductFieldClock: await count('ProductFieldClock', shopId),
  });

  async function deliverEvents(w: World) {
    const found = await db.query<{ payload: EventEnvelope }>(
      `SELECT payload FROM "Outbox"
        WHERE "aggregateType" = 'products' AND "type" LIKE 'catalog.product\\_%' AND "type" <> 'catalog.product_changed'
          AND payload->'payload'->>'shopId' = :shopId ORDER BY "id"`,
      { type: QueryTypes.SELECT, replacements: { shopId: w.shopId } },
    );
    for (const row of found) await feedConsumer.project([row.payload]);
  }

  /** A shop that has every kind of sync data: operations, a conflict, clocks and feed entries. */
  async function populated() {
    const w = await world();
    const p = await product(w, 5);
    await pushOk(w, [
      adjust(p.id, 2),
      titleEdit(p.id, 'New title', -SECOND),
      adjust(p.id, -100),
    ]);
    await deliverEvents(w);
    await lifecycle.ensureFeedBuilt(w.shopId);
    return { w, productId: p.id };
  }

  const deletedEnvelope = (shopId: string): EventEnvelope =>
    ShopDeleted.create(shopId, 5, { shopId, shopVersion: 5 });

  const productDeletedEnvelope = (
    shopId: string,
    productId: string,
  ): EventEnvelope => ({
    eventId: randomUUID(),
    type: 'catalog.product_deleted',
    version: 1,
    aggregateType: 'products',
    aggregateId: productId,
    aggregateVersion: 9,
    occurredAt: ctx.clock.now().toISOString(),
    payload: { productId, shopId, productVersion: 9 },
  });

  /** Writes an operation record the way a push would have, at an age. */
  async function agedOperation(
    w: World,
    ageDays: number,
    options: { conflict?: 'open' | 'dismissed' } = {},
  ): Promise<string> {
    const at = new Date(ctx.clock.now().getTime() - ageDays * DAY);
    const productId = randomUUID();
    const raw = adjust(productId, -1);
    const parsed = parseOp(raw);
    if (!parsed.ok) throw new Error('fixture invalid');
    const claimed = await operations.claim({
      shopId: w.shopId,
      opId: raw.opId,
      deviceId: 'dev-a',
      userId: w.owner.id,
      type: 'stock.adjust',
      productId,
      hlc: raw.hlc,
      fingerprint: fingerprint(parsed.op),
      content: { delta: -1, reason: 'sold' },
      now: at,
    });
    expect(claimed.kind).toBe('claimed');
    await operations.complete(
      w.shopId,
      raw.opId,
      options.conflict
        ? { status: 'conflict', quantityAfter: 0, detail: { delta: -1 } }
        : { status: 'applied', quantityAfter: 1 },
      options.conflict
        ? {
            deviceId: 'dev-a',
            productId,
            kind: 'oversold',
            requested: -1,
            applied: 0,
            shortfall: 1,
            quantityAfter: 0,
          }
        : null,
      at,
    );
    if (options.conflict === 'dismissed')
      await conflicts.dismiss(w.shopId, raw.opId, w.owner.id, at);
    return raw.opId;
  }

  const operationIds = async (shopId: string) =>
    (
      await db.query<{ opId: string }>(
        `SELECT "opId" FROM "SyncOperation" WHERE "shopId" = :shopId`,
        { type: QueryTypes.SELECT, replacements: { shopId } },
      )
    ).map((r) => r.opId);

  function captureLogs(): Array<Record<string, unknown> | string> {
    const lines: Array<Record<string, unknown> | string> = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      logSpies.push(
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            const first = args[0];
            lines.push(
              typeof first === 'object' && first !== null
                ? (first as Record<string, unknown>)
                : String(first),
            );
          }),
      );
    return lines;
  }

  // ---- AS-48 / AS-49 ------------------------------------------------------------------------------------------

  it("S09 AS-48: the shop-deleted event removes all of the shop's sync data once, leaves other shops alone and dead-letters a bad payload", async () => {
    const doomed = await populated();
    const kept = await populated();
    const before = await counts(doomed.w.shopId);
    expect(Object.values(before).every((n) => n > 0)).toBe(true);
    const keptBefore = await counts(kept.w.shopId);
    const event = deletedEnvelope(doomed.w.shopId);

    await shopDeleted.project([event]);
    await shopDeleted.project([{ ...event, eventId: randomUUID() }]);

    expect(await counts(doomed.w.shopId)).toEqual({
      SyncOperation: 0,
      SyncConflict: 0,
      ShopChangeLog: 0,
      ShopSyncState: 0,
      ProductFieldClock: 0,
    });
    expect(await counts(kept.w.shopId)).toEqual(keptBefore);

    for (const bad of [
      { ...event, payload: {} },
      { ...event, payload: { shopId: 'not-a-uuid', shopVersion: 5 } },
    ])
      await expect(shopDeleted.project([bad])).rejects.toBeInstanceOf(
        PermanentError,
      );
    expect(await counts(kept.w.shopId)).toEqual(keptBefore);
  });

  it("S09 AS-49: the product-deleted event removes the product's clocks once and keeps its operations", async () => {
    const { w, productId } = await populated();
    const other = await product(w);
    await pushOk(w, [titleEdit(other.id, 'Other title', -SECOND)]);
    expect(await count('ProductFieldClock', w.shopId)).toBe(2);
    const operationsBefore = await count('SyncOperation', w.shopId);
    const event = productDeletedEnvelope(w.shopId, productId);

    await productDeleted.project([event]);
    await productDeleted.project([{ ...event, eventId: randomUUID() }]);

    expect(await count('ProductFieldClock', w.shopId)).toBe(1);
    const left = await db.query<{ productId: string }>(
      `SELECT "productId" FROM "ProductFieldClock" WHERE "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId: w.shopId } },
    );
    expect(left[0].productId).toBe(other.id);
    expect(await count('SyncOperation', w.shopId)).toBe(operationsBefore);
    await expect(
      productDeleted.project([{ ...event, payload: { productId } }]),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  // ---- AS-50 --------------------------------------------------------------------------------------------------

  it('S09 AS-50: operation records are purged after 90 days, open conflicts excepted, dismissed ones follow their operation', async () => {
    const w = await world();
    await agedOperation(w, 95);
    const kept = await agedOperation(w, 85);
    const young = await agedOperation(w, 10);
    const openConflict = await agedOperation(w, 120, { conflict: 'open' });
    await agedOperation(w, 100, { conflict: 'dismissed' });
    const other = await world();
    await agedOperation(other, 200);

    await Promise.all([
      lifecycle.purgeOperations(),
      lifecycle.purgeOperations(),
    ]);
    await lifecycle.purgeOperations();

    expect((await operationIds(w.shopId)).sort()).toEqual(
      [kept, young, openConflict].sort(),
    );
    expect(await operationIds(other.shopId)).toEqual([]); // 200 days, no conflict: gone as well
    const remaining = await db.query<{ opId: string; status: string }>(
      `SELECT "opId", "status" FROM "SyncConflict" WHERE "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId: w.shopId } },
    );
    expect(remaining).toEqual([{ opId: openConflict, status: 'open' }]);
  });

  // ---- AS-51 --------------------------------------------------------------------------------------------------

  it('S09 AS-51: logs carry identifiers and outcomes and no product content, and the metrics count the operations', async () => {
    const w = await world();
    const p = await product(w, 1);
    await pushOk(w, [titleEdit(p.id, 'Newest title', -SECOND)]); // sets a clock, so the next edit can lose
    const lines = captureLogs();
    const counter = (type: string, status: string) =>
      MetricsRegistry.value('catalog_sync_offline_ops_total', {
        type,
        status,
      }) ?? 0;
    const before = {
      applied: counter('stock.adjust', 'applied'),
      merged: counter('product.update', 'merged'),
      conflict: counter('stock.adjust', 'conflict'),
    };
    const durations =
      MetricsRegistry.histogramValue(
        'catalog_sync_offline_push_duration_seconds',
      )?.count ?? 0;
    const sale = adjust(p.id, -1);
    const oversell = adjust(p.id, -5);

    const results = await pushOk(w, [
      sale,
      titleEdit(p.id, 'Stale secret title', -20 * SECOND),
      oversell,
    ]);

    expect(results.map((r: SyncOpResult) => r.status)).toEqual([
      'applied',
      'merged',
      'conflict',
    ]);
    const lineOf = (opId: string) =>
      lines.find(
        (l) =>
          typeof l === 'object' &&
          l.action === 'catalog-sync.offline_op' &&
          l.opId === opId,
      ) as Record<string, unknown>;
    for (const [opId, type, status] of [
      [sale.opId, 'stock.adjust', 'applied'],
      [results[1].opId!, 'product.update', 'merged'],
      [oversell.opId, 'stock.adjust', 'conflict'],
    ] as const)
      expect(lineOf(opId)).toMatchObject({
        shopId: w.shopId,
        deviceId: 'dev-a',
        opId,
        type,
        status,
        requestId: expect.any(String),
        durationMs: expect.any(Number),
      });
    const summary = lines.find(
      (l) => typeof l === 'object' && l.action === 'catalog-sync.offline_push',
    ) as Record<string, unknown>;
    expect(summary).toMatchObject({
      shopId: w.shopId,
      deviceId: 'dev-a',
      ops: 3,
      requestId: expect.any(String),
    });
    const text = JSON.stringify(lines);
    expect(text).not.toMatch(/Secret|Stale secret|Newest title|description/);

    expect(counter('stock.adjust', 'applied')).toBe(before.applied + 1);
    expect(counter('product.update', 'merged')).toBe(before.merged + 1);
    expect(counter('stock.adjust', 'conflict')).toBe(before.conflict + 1);
    expect(
      MetricsRegistry.histogramValue(
        'catalog_sync_offline_push_duration_seconds',
      )?.count,
    ).toBe(durations + 1);
    // labels are closed sets: no identifier or content ever became one
    for (const labels of MetricsRegistry.labelSets(
      'catalog_sync_offline_ops_total',
    ))
      expect(Object.keys(labels).sort()).toEqual(['status', 'type']);

    await lifecycle.refreshGauges();
    const open = Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM "SyncConflict" WHERE "status" = 'open'`,
          { type: QueryTypes.SELECT },
        )
      )[0].n,
    );
    const pending = Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM "SyncOperation" WHERE "status" = 'pending'`,
          { type: QueryTypes.SELECT },
        )
      )[0].n,
    );
    expect(MetricsRegistry.value('catalog_sync_offline_conflicts_open')).toBe(
      open,
    );
    expect(MetricsRegistry.value('catalog_sync_offline_ops_in_flight')).toBe(
      pending,
    );

    await deliverEvents(w);
    expect(
      MetricsRegistry.value('catalog_sync_offline_feed_lag_seconds'),
    ).toEqual(expect.any(Number));
    for (const name of OFFLINE_METRIC_NAMES)
      expect(MetricsRegistry.seriesCount(name)).toBeGreaterThan(0);
  });

  // ---- AS-52 --------------------------------------------------------------------------------------------------

  it("S09 AS-52: every stock change is one catalog command with a deterministic id, the events are the catalog's and a replay calls nothing", async () => {
    const w = await world();
    const p = await product(w, 2);
    const spy = jest.spyOn(stockService, 'applyStockDelta');
    try {
      const plain = adjust(p.id, 3);
      const clamped = adjust(p.id, -10); // only 5 are there: applies -5, shortfall 5
      const results = await pushOk(w, [plain, clamped]);
      expect(results.map((r) => r.status)).toEqual(['applied', 'conflict']);

      const ids = spy.mock.calls.map((call) => call[0][0].operationId);
      expect(ids).toEqual([
        `sync:${w.shopId}:${plain.opId}`,
        `sync:${w.shopId}:${clamped.opId}`,
        `sync:${w.shopId}:${clamped.opId}:clamp`,
      ]);
      expect(
        spy.mock.calls.every(
          (call) => call[0].length === 1 && call[0][0].shopId === w.shopId,
        ),
      ).toBe(true);

      spy.mockClear();
      const replay = await pushOk(w, [plain, clamped]);
      expect(replay.map((r) => r.replayed)).toEqual([true, true]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    const events = await productEvents(ctx.app, p.id);
    const stockEvents = events.filter(
      (e) =>
        (e.payload.changedFields as string[]).includes('quantity') &&
        e.type === 'catalog.product_updated',
    );
    expect(stockEvents).toHaveLength(2);
    expect(
      events.every(
        (e) =>
          e.aggregateType === 'products' &&
          e.type.startsWith('catalog.product_'),
      ),
    ).toBe(true);
    expect(events.map((e) => e.type)).not.toContain('catalog.product_changed');
    expect(
      (await query.getProductsByIds([p.id], { shopId: w.shopId })).get(p.id)!
        .quantity,
    ).toBe(0);
  });

  // ---- AS-55 --------------------------------------------------------------------------------------------------

  it("S09 AS-55: compaction removes superseded entries and old tombstones, keeps the newest per product, raises the horizon and changes no young cursor's final state", async () => {
    const w = await world();
    await lifecycle.ensureFeedBuilt(w.shopId);
    const now = ctx.clock.now().getTime();
    const ago = (days: number) => new Date(now - days * DAY);
    const state = (title: string) => ({
      title,
      description: '',
      priceMinor: 100,
      currency: 'USD',
      quantity: 1,
      status: 'ACTIVE' as const,
    });
    const [p1, p2, p3, p4, p5] = Array.from({ length: 5 }, () => randomUUID());
    const append = (
      productId: string,
      version: number,
      days: number,
      deleted = false,
    ) =>
      feed.append(w.shopId, {
        productId,
        version,
        deleted,
        data: deleted ? null : state(`${productId.slice(0, 4)} v${version}`),
        occurredAt: ago(days),
      });
    await append(p1, 1, 40); // seq 1: superseded and old -> removed
    await append(p1, 2, 39); // seq 2: newest of p1 -> kept
    await append(p2, 1, 35); // seq 3: newest of p2 -> kept
    await append(p3, 1, 35); // seq 4: superseded by the tombstone, old -> removed
    await append(p3, 2, 33, true); // seq 5: old tombstone -> removed
    await append(p4, 1, 32); // seq 6: superseded, old -> removed
    await append(p4, 2, 5); // seq 7: newest of p4 -> kept
    await append(p5, 1, 3); // seq 8: young -> kept
    await append(p3, 3, 10, true); // seq 9: a young tombstone (the product came back and went again) -> kept
    const young = 6; // a cursor issued after the oldest superseded entries
    const finalState = async (after: number) => {
      const entries = await feed.page(w.shopId, after, 500);
      return new Map(entries.map((e) => [e.productId, e.version]));
    };
    const before = await finalState(young);

    await lifecycle.compactFeeds();
    await Promise.all([lifecycle.compactFeeds(), lifecycle.compactFeeds()]);
    await lifecycle.compactFeeds();

    const left = await feed.page(w.shopId, 0, 500);
    expect(left.map((e) => e.seq)).toEqual([2, 3, 7, 8, 9]);
    expect(await finalState(young)).toEqual(before);
    const horizon = await feed.state(w.shopId);
    expect(horizon?.horizonSeq).toBe(6);
    expect(horizon?.horizonAt).toEqual(ctx.clock.now());
    expect(horizon?.lastSeq).toBe(9);
  });

  // ---- jobs ---------------------------------------------------------------------------------------------------

  it('S09 AS-14: the worker registers the recovery, compaction and purge schedules, and the backfill job rebuilds a feed', async () => {
    const schedules = await db.query<{
      name: string;
      jobType: string;
      cron: string;
    }>(
      `SELECT "name", "jobType", "cron" FROM "JobSchedule" WHERE "name" LIKE 'catalog-sync.%' ORDER BY "name"`,
      { type: QueryTypes.SELECT },
    );
    const names = schedules.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'catalog-sync.compact-change-log',
        'catalog-sync.purge-sync-operations',
        'catalog-sync.redrive-stale-ops',
      ]),
    );
    expect(
      schedules.find((s) => s.name === 'catalog-sync.redrive-stale-ops')?.cron,
    ).toBe('0 * * * * *');
    expect(names).not.toContain('catalog-sync.backfill-change-log');

    const w = await world();
    await product(w, 4);
    await lifecycle.ensureFeedBuilt(w.shopId);
    const first = await feed.state(w.shopId);
    await jobs.backfill({ shopId: w.shopId });
    const second = await feed.state(w.shopId);
    expect(second!.generation).toBe(first!.generation + 1);
    expect(await feed.page(w.shopId, 0, 10)).toHaveLength(1);
  });
});
