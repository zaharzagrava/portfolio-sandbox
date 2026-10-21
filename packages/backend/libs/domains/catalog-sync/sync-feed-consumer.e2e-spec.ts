import { randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { EntitlementsService } from '@app/domains/billing';
import {
  ProductCommandService,
  ProductStockService,
} from '@app/domains/catalog';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';
import {
  OfflineSyncModule,
  OfflineSyncProjectorModule,
  OfflineSyncWorkerModule,
} from './sync.module';
import { SYNC_FEED_REPOSITORY, type SyncFeedRepository } from './domain/ports';
import { SyncFeedConsumer } from './infra/sync-feed.consumer';

/**
 * AS-26 creates 30 products in one shop; the free plan allows 10 live ones and that limit is not what this spec proves
 * (catalog's product-plan-limit spec does), so the plan answer here is an uncapped one.
 */
const uncappedPlan = {
  checkLimit: async () => ({ allowed: true, limit: null, remaining: null }),
};

describe('Offline sync: change feed consumers', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let commands: ProductCommandService;
  let stock: ProductStockService;
  let feed: SyncFeedRepository;
  let consumer: SyncFeedConsumer;

  beforeAll(async () => {
    ctx = await createCatalogApp({
      overrides: [{ provide: EntitlementsService, useValue: uncappedPlan }],
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
    feed = ctx.app.get(SYNC_FEED_REPOSITORY, { strict: false });
    consumer = ctx.app.select(OfflineSyncProjectorModule).get(SyncFeedConsumer);
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
  type World = Awaited<ReturnType<typeof world>>;

  async function product(w: World, quantity = 10) {
    return commands.create(w.shopId, w.owner.id, {
      title: 'Mug',
      description: 'A mug',
      brand: 'Acme',
      category: 'home',
      priceMinor: 1_000,
      quantity,
    });
  }

  /** The envelopes of the product events the catalog appended to the outbox, oldest version first. */
  async function envelopes(productId: string): Promise<EventEnvelope[]> {
    const found = await db.query<{ payload: EventEnvelope }>(
      `SELECT payload FROM "Outbox" WHERE "aggregateId" = :productId AND "type" LIKE 'catalog.product\\_%'
        ORDER BY (payload->>'aggregateVersion')::int, "createdAt"`,
      { type: QueryTypes.SELECT, replacements: { productId } },
    );
    return found
      .map((r) => r.payload)
      .filter((e) => e.type !== 'catalog.product_changed');
  }

  const entries = (shopId: string, after = 0) => feed.page(shopId, after, 500);

  const withPayload = (
    event: EventEnvelope,
    patch: Record<string, unknown>,
  ): EventEnvelope => ({
    ...event,
    eventId: randomUUID(),
    payload: { ...event.payload, ...patch },
  });

  const without = (event: EventEnvelope, key: string): EventEnvelope => {
    const payload = { ...event.payload };
    delete payload[key];
    return { ...event, eventId: randomUUID(), payload };
  };

  // ---- AS-26 --------------------------------------------------------------------------------------------------

  it('S09 AS-26: thirty events of one shop delivered at once get seq 1 to 30 without a gap, and a polling device misses nothing', async () => {
    const w = await world();
    const events: EventEnvelope[] = [];
    for (let i = 0; i < 30; i++) {
      const p = await product(w);
      events.push(...(await envelopes(p.id)));
    }
    expect(events).toHaveLength(30);

    let delivering = true;
    const seen: number[] = [];
    const poller = (async () => {
      let after = 0;
      while (delivering || after < 30) {
        const page = await feed.page(w.shopId, after, 7);
        for (const entry of page) {
          // A change never shows up below a position the device already holds.
          expect(entry.seq).toBeGreaterThan(after);
          seen.push(entry.seq);
          after = entry.seq;
        }
        if (page.length === 0) await new Promise((r) => setTimeout(r, 5));
      }
    })();

    await Promise.all(events.map((event) => consumer.project([event])));
    delivering = false;
    await poller;

    const all = await entries(w.shopId);
    expect(all.map((e) => e.seq)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    expect(seen).toEqual(all.map((e) => e.seq));
    expect((await feed.state(w.shopId))?.lastSeq).toBe(30);
    expect(new Set(all.map((e) => e.productId)).size).toBe(30);
  }, 60_000);

  // ---- AS-27 --------------------------------------------------------------------------------------------------

  it('S09 AS-27: a version delivered twice makes one entry, an older version arriving later is ignored', async () => {
    const w = await world();
    const p = await product(w);
    for (let i = 0; i < 6; i++) {
      const current = (await commands.getForShop(w.shopId, p.id)).version;
      await commands.update(
        w.shopId,
        p.id,
        { expectedVersion: current, title: `Mug ${i}` },
        w.owner.id,
      );
    }
    const all = await envelopes(p.id);
    expect(all.map((e) => e.aggregateVersion)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const [v6, v7] = [all[5], all[6]];

    await consumer.project([v7]);
    await consumer.project([v7]);
    await consumer.project([withPayload(v7, {})]); // same version, new event id
    expect((await entries(w.shopId)).map((e) => e.version)).toEqual([7]);

    await consumer.project([v6]);
    const after = await entries(w.shopId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ version: 7, productId: p.id });
    expect(after[0].data?.title).toBe('Mug 5');
    expect((await feed.state(w.shopId))?.lastSeq).toBe(1);
  });

  // ---- AS-28 --------------------------------------------------------------------------------------------------

  it('S09 AS-28: an event that cannot be applied is dead-lettered, the feed is unchanged and the next event goes on', async () => {
    const w = await world();
    const p = await product(w);
    const [created] = await envelopes(p.id);
    const bad: Array<[string, EventEnvelope]> = [
      ['a missing shopId', without(created, 'shopId')],
      ['a missing productVersion', without(created, 'productVersion')],
      [
        'a malformed product id',
        withPayload(created, { productId: 'not-a-uuid' }),
      ],
      ['a malformed shop id', withPayload(created, { shopId: 'nope' })],
      ['a version zero', withPayload(created, { productVersion: 0 })],
      [
        'an unsupported envelope version',
        { ...created, eventId: randomUUID(), version: 2 },
      ],
      [
        'an unknown product event type',
        {
          ...created,
          eventId: randomUUID(),
          type: 'catalog.product_teleported',
        },
      ],
    ];
    const accepted: string[] = [];
    for (const [name, event] of bad) {
      try {
        await consumer.project([event]);
        accepted.push(name);
      } catch (error) {
        if (!(error instanceof PermanentError)) throw error;
      }
      expect((await entries(w.shopId)).length).toBe(0);
    }
    expect(accepted).toEqual([]);
    // A batch with one bad event applies nothing of it, and the good event that follows still goes through.
    await expect(consumer.project([created, bad[0][1]])).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect((await entries(w.shopId)).length).toBe(0);
    await consumer.project([created]);
    expect(await entries(w.shopId)).toHaveLength(1);
    // Events of other families are not this feed's business and are not an error.
    await consumer.project([
      { ...created, eventId: randomUUID(), type: 'orders.order_paid' },
    ]);
    expect(await entries(w.shopId)).toHaveLength(1);
  });

  // ---- AS-29 --------------------------------------------------------------------------------------------------

  it('S09 AS-29: archive, restore and delete appear in the feed in that order, the delete as a tombstone', async () => {
    const w = await world();
    const p = await product(w);
    const v2 = await commands.archive(w.shopId, p.id, p.version, w.owner.id);
    const v3 = await commands.restore(w.shopId, p.id, v2.version, w.owner.id);
    const events = await envelopes(p.id);
    expect(events.map((e) => e.type)).toEqual([
      'catalog.product_created',
      'catalog.product_archived',
      'catalog.product_restored',
    ]);
    const deleted: EventEnvelope = {
      eventId: randomUUID(),
      type: 'catalog.product_deleted',
      version: 1,
      aggregateType: 'products',
      aggregateId: p.id,
      aggregateVersion: v3.version + 1,
      occurredAt: new Date().toISOString(),
      payload: {
        productId: p.id,
        shopId: w.shopId,
        productVersion: v3.version + 1,
      },
    };

    for (const event of [...events, deleted]) await consumer.project([event]);

    const rows = await entries(w.shopId);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(
      rows.map((r) => [r.version, r.deleted, r.data?.status ?? null]),
    ).toEqual([
      [1, false, 'ACTIVE'],
      [2, false, 'ARCHIVED'],
      [3, false, 'ACTIVE'],
      [4, true, null],
    ]);
    expect(rows[3].data).toBeNull();
  });

  it('S09 AS-24: every kind of change reaches the feed with the state it left', async () => {
    const w = await world();
    const p = await product(w, 10);
    await stock.applyStockDelta([
      {
        operationId: `order-${randomUUID()}`,
        productId: p.id,
        shopId: w.shopId,
        delta: -4,
        reason: 'order.reserved',
      },
    ]);
    const current = await commands.getForShop(w.shopId, p.id);
    await commands.update(
      w.shopId,
      p.id,
      { expectedVersion: current.version, priceMinor: 2_500 },
      w.owner.id,
    );

    for (const event of await envelopes(p.id)) await consumer.project([event]);

    const rows = await entries(w.shopId);
    expect(rows.map((r) => r.data)).toEqual([
      {
        title: 'Mug',
        description: 'A mug',
        priceMinor: 1_000,
        currency: expect.any(String),
        quantity: 10,
        status: 'ACTIVE',
      },
      {
        title: 'Mug',
        description: 'A mug',
        priceMinor: 1_000,
        currency: expect.any(String),
        quantity: 6,
        status: 'ACTIVE',
      },
      {
        title: 'Mug',
        description: 'A mug',
        priceMinor: 2_500,
        currency: expect.any(String),
        quantity: 6,
        status: 'ACTIVE',
      },
    ]);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
  });
});
