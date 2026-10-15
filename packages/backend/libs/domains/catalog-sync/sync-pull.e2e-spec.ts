import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import {
  syncPullResponseSchema,
  syncPushResponseSchema,
  type SyncPullResponse,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import {
  ProductCommandService,
  ProductStockService,
} from '@app/domains/catalog';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';
import {
  OfflineSyncModule,
  OfflineSyncProjectorModule,
  OfflineSyncWorkerModule,
} from './sync.module';
import { SyncLifecycleService } from './application/sync-lifecycle.service';
import { encodeHlc } from './domain/hlc';
import { encodeSyncCursor } from './domain/sync-cursor';
import { SyncFeedConsumer } from './infra/sync-feed.consumer';

const DAY = 86_400_000;

describe('Offline sync: pull and change feed', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let commands: ProductCommandService;
  let stock: ProductStockService;
  let consumer: SyncFeedConsumer;
  let lifecycle: SyncLifecycleService;
  let cursorKey: string;
  let logical = 0;

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
    stock = ctx.app.get(ProductStockService);
    consumer = ctx.app.select(OfflineSyncProjectorModule).get(SyncFeedConsumer);
    lifecycle = ctx.app.get(SyncLifecycleService, { strict: false });
    cursorKey = ctx.app.get(ApiConfigService).get('integration_cursor_key');
  });

  afterAll(async () => {
    await ctx.close();
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  async function world() {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    return { owner, shopId: shop.id };
  }
  type World = { owner: TestUser; shopId: string };

  async function product(w: World, quantity = 10, title = 'Mug') {
    return commands.create(w.shopId, w.owner.id, {
      title,
      description: 'A mug',
      brand: 'Acme',
      category: 'home',
      priceMinor: 1_000,
      quantity,
    });
  }

  /** What the projector does with the catalog's events: every product event of the shop reaches the feed consumer. */
  async function deliver(w: World) {
    const found = await db.query<{ payload: EventEnvelope }>(
      `SELECT payload FROM "Outbox"
        WHERE "aggregateType" = 'products' AND "type" LIKE 'catalog.product\\_%' AND "type" <> 'catalog.product_changed'
          AND payload->'payload'->>'shopId' = :shopId
        ORDER BY "id"`,
      { type: QueryTypes.SELECT, replacements: { shopId: w.shopId } },
    );
    for (const row of found) await consumer.project([row.payload]);
  }

  const pull = (w: World, query = '', device = 'dev-a') =>
    ctx
      .as(w.owner)
      .get(`/api/shops/${w.shopId}/sync/pull${query}`)
      .set('X-Device-Id', device);

  async function pullOk(w: World, query = ''): Promise<SyncPullResponse> {
    const res = await pull(w, query);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return syncPullResponseSchema.parse(res.body);
  }

  const cursorQuery = (cursor: string, limit?: number) =>
    `?cursor=${encodeURIComponent(cursor)}${limit ? `&limit=${limit}` : ''}`;

  const pushStock = async (w: World, productId: string, delta: number) => {
    const res = await ctx
      .as(w.owner)
      .post(`/api/shops/${w.shopId}/sync/push`)
      .set('X-Device-Id', 'dev-a')
      .send({
        ops: [
          {
            type: 'stock.adjust',
            opId: uuidv7(),
            hlc: encodeHlc({
              physical: ctx.clock.now().getTime(),
              logical: ++logical,
              node: 'dev-a',
            }),
            productId,
            delta,
            reason: 'received',
          },
        ],
      });
    expect(res.status).toBe(200);
    return syncPushResponseSchema.parse(res.body).results[0];
  };

  // ---- AS-24 / AS-25 / AS-30 ----------------------------------------------------------------------------------

  it('S09 AS-24: an online order, a dashboard edit and a device push come back in order after the cursor, and then nothing', async () => {
    const w = await world();
    const p = await product(w, 10);
    await deliver(w);
    const start = await pullOk(w); // the state at cursor C
    expect(start.changes).toHaveLength(1);
    expect(start.changes[0]).toMatchObject({
      id: p.id,
      version: 1,
      deleted: false,
    });

    await stock.applyStockDelta([
      {
        operationId: `order-${randomUUID()}`,
        productId: p.id,
        shopId: w.shopId,
        delta: -3,
        reason: 'order.reserved',
      },
    ]);
    const current = await commands.getForShop(w.shopId, p.id);
    await commands.update(
      w.shopId,
      p.id,
      { expectedVersion: current.version, title: 'Mug v2' },
      w.owner.id,
    );
    const pushed = await pushStock(w, p.id, 5);
    await deliver(w);

    const page = await pullOk(w, cursorQuery(start.cursor));

    expect(page.changes.map((c) => c.seq)).toEqual([
      start.changes[0].seq + 1,
      start.changes[0].seq + 2,
      start.changes[0].seq + 3,
    ]);
    expect(page.changes.map((c) => c.version)).toEqual([2, 3, 4]);
    expect(
      page.changes.every(
        (c) => c.entity === 'product' && c.id === p.id && !c.deleted,
      ),
    ).toBe(true);
    expect(page.changes.map((c) => [c.data?.title, c.data?.quantity])).toEqual([
      ['Mug', 7],
      ['Mug v2', 7],
      ['Mug v2', 12],
    ]);
    expect(Object.keys(page.changes[0].data!).sort()).toEqual([
      'currency',
      'description',
      'priceMinor',
      'quantity',
      'status',
      'title',
    ]);
    expect(page.changes[2].version).toBe(pushed.productVersion);
    expect(page.hasMore).toBe(false);

    const empty = await pullOk(w, cursorQuery(page.cursor));
    expect(empty.changes).toEqual([]);
    expect(empty.cursor).toBe(page.cursor);
    expect(empty.hasMore).toBe(false);
  });

  it('S09 AS-25: following the cursors page by page gives every change once, with no gap and no repeat', async () => {
    const w = await world();
    const initial = await pullOk(w); // an empty shop: the feed is built and the cursor is at its start
    expect(initial.changes).toEqual([]);
    const p = await product(w, 10);
    for (let i = 0; i < 4; i++) await pushStock(w, p.id, 1);
    await deliver(w);

    const pages: SyncPullResponse[] = [];
    let cursor = initial.cursor;
    for (let guard = 0; guard < 10; guard++) {
      const page = await pullOk(w, cursorQuery(cursor, 2));
      pages.push(page);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }

    expect(pages.map((x) => x.changes.length)).toEqual([2, 2, 1]);
    expect(pages.map((x) => x.hasMore)).toEqual([true, true, false]);
    const seqs = pages.flatMap((x) => x.changes.map((c) => c.seq));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(pages.flatMap((x) => x.changes.map((c) => c.version))).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('S09 AS-30: the version a push returns is the version of the feed entry, with the quantity the device already holds', async () => {
    const w = await world();
    const p = await product(w, 10);
    await deliver(w);
    const start = await pullOk(w);

    const pushed = await pushStock(w, p.id, 5);
    await deliver(w);
    const page = await pullOk(w, cursorQuery(start.cursor));

    expect(page.changes).toHaveLength(1);
    expect(page.changes[0].version).toBe(pushed.productVersion);
    expect(page.changes[0].data?.quantity).toBe(pushed.quantityAfter);
    expect(page.changes[0].version).toBeGreaterThan(start.changes[0].version);
  });

  // ---- AS-31 --------------------------------------------------------------------------------------------------

  it('S09 AS-31: a bad cursor or limit is a 400 with nothing returned and no silent start from the beginning', async () => {
    const a = await world();
    const b = await world();
    await product(a);
    await deliver(a);
    const foreign = (await pullOk(b)).cursor;

    const cases: Array<[string, string, string]> = [
      ['a malformed cursor', '?cursor=abc', 'invalid_cursor'],
      ['a number as cursor', '?cursor=12', 'invalid_cursor'],
      ['a cursor of another shop', cursorQuery(foreign), 'invalid_cursor'],
      ['limit 0', '?limit=0', 'validation_failed'],
      ['limit 501', '?limit=501', 'validation_failed'],
      ['limit abc', '?limit=abc', 'validation_failed'],
      ['a negative limit', '?limit=-1', 'validation_failed'],
      ['an unknown parameter', '?since=3', 'validation_failed'],
    ];
    for (const [name, query, code] of cases) {
      const res = await pull(a, query);
      expect([name, res.status, res.body.code]).toEqual([name, 400, code]);
      expect(res.body.changes).toBeUndefined();
    }
    // Both ends of the limit are accepted.
    expect((await pull(a, '?limit=1')).status).toBe(200);
    expect((await pull(a, '?limit=500')).status).toBe(200);
  });

  // ---- AS-32 --------------------------------------------------------------------------------------------------

  it('S09 AS-32: a cursor from before a rebuild, ahead of the head or past the compaction horizon is 410, and a pull without a cursor starts over', async () => {
    const w = await world();
    const alive = await product(w, 10, 'Alive');
    const other = await product(w, 10, 'Other');
    await deliver(w);
    const first = await pullOk(w);
    expect(first.changes).toHaveLength(2);

    // 1. a cursor from before the feed was rebuilt (a new generation)
    await lifecycle.rebuildFeed(w.shopId);
    const rebuilt = await pull(w, cursorQuery(first.cursor));
    expect([rebuilt.status, rebuilt.body.code]).toEqual([
      410,
      'resync_required',
    ]);

    // 2. a cursor ahead of the head
    const state = await pullOk(w);
    const generation = Number(
      Buffer.from(state.cursor, 'base64url').toString().split('.')[2],
    );
    const ahead = encodeSyncCursor(
      { shopId: w.shopId, generation, seq: 9_999 },
      cursorKey,
    );
    const aheadRes = await pull(w, cursorQuery(ahead));
    expect([aheadRes.status, aheadRes.body.code]).toEqual([
      410,
      'resync_required',
    ]);

    // 3. a cursor older than the compaction horizon (30 days, frozen clock)
    const start = encodeSyncCursor(
      { shopId: w.shopId, generation, seq: 0 },
      cursorKey,
    );
    expect((await pull(w, cursorQuery(start))).status).toBe(200);
    const current = await commands.getForShop(w.shopId, alive.id);
    await commands.update(
      w.shopId,
      alive.id,
      { expectedVersion: current.version, title: 'Alive 2' },
      w.owner.id,
    );
    await deliver(w);
    ctx.clock.advance(31 * DAY);
    await ctx.reauth(w.owner);
    await lifecycle.compactFeeds();
    const old = await pull(w, cursorQuery(start));
    expect([old.status, old.body.code]).toEqual([410, 'resync_required']);

    // The device pulls again without a cursor: the current state of every product, then ordinary pulls continue.
    const fresh = await pullOk(w, '?limit=500');
    const byProduct = new Map(fresh.changes.map((c) => [c.id, c]));
    expect(byProduct.get(alive.id)).toMatchObject({ deleted: false });
    expect(byProduct.get(alive.id)?.data?.title).toBe('Alive 2');
    expect(byProduct.get(other.id)?.data?.title).toBe('Other');
    expect(fresh.hasMore).toBe(false);
    const next = await pullOk(w, cursorQuery(fresh.cursor));
    expect(next.changes).toEqual([]);
  });

  it('S09 AS-32: a shop whose feed was never built is built from the catalog on the first pull', async () => {
    const w = await world();
    const p = await product(w, 7, 'Before the feed');
    // No event reached the feed yet: the first pull reads the catalog.
    const first = await pullOk(w);
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]).toMatchObject({
      id: p.id,
      version: 1,
      deleted: false,
    });
    expect(first.changes[0].data?.quantity).toBe(7);

    // The event of that very product then arrives: the version is known, so it makes no second entry.
    await deliver(w);
    const next = await pullOk(w, cursorQuery(first.cursor));
    expect(next.changes).toEqual([]);
  });
});
