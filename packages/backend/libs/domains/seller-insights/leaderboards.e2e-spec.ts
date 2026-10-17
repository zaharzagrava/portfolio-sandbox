import { v4 as uuidv4 } from 'uuid';
import {
  leaderboardPageSchema,
  liveDashboardFrameSchema,
  shopRankSchema,
} from '@marketplace-sandbox/contracts';
import { BoardProjector } from './infra/projectors/board.projector';
import { LiveProjector } from './infra/projectors/live.projector';
import {
  createInsightsApp,
  T0,
  type InsightsTestApp,
} from './testing/insights-fixtures';

/**
 * The first SD-18 scenarios, kept end to end through the real feeds and routes of the capability: ties and replays,
 * the discounted line, the snapshot that outlives the board store, the live window. The detailed scenarios are in the
 * sibling files (`leaderboard-feed`, `leaderboard-read`, `leaderboard-snapshots`, `dashboard-live`).
 */
describe('Leaderboards & live dashboard (e2e)', () => {
  let t: InsightsTestApp;

  beforeAll(async () => {
    t = await createInsightsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
  const list = async (query = 'period=week') =>
    leaderboardPageSchema.parse(
      (await t.http().get(`/api/leaderboards?${query}`).expect(200)).body,
    ).entries;

  it('S40 AS-04: ranks by revenue, the earlier sale wins ties, replays never double count, category boards are separate', async () => {
    const [alpha, beta] = await t.trio();
    const phone = await t.product(alpha.shopId, 'electronics');
    const cable = await t.product(alpha.shopId, 'accessories');
    const first = t.paid({
      paidAt: at(-60),
      lines: [
        { shopId: alpha.shopId, productId: phone, lineTotalMinor: 10_000 },
      ],
    });
    await t.deliver(t.projector(BoardProjector), [
      first,
      t.paid({
        paidAt: at(-30),
        lines: [
          { shopId: beta.shopId, productId: phone, lineTotalMinor: 10_000 },
        ],
      }),
    ]);
    await t.deliver(t.projector(BoardProjector), [first]); // redelivery

    expect((await list()).map((e) => e.name)).toEqual(['Alpha', 'Beta']);
    expect(await t.board(t.week(), 'all')).toEqual([
      { shopId: alpha.shopId, revenueMinor: 10_000 },
      { shopId: beta.shopId, revenueMinor: 10_000 },
    ]);
    expect(await t.board(t.month(), 'cat:electronics')).toHaveLength(2);
    expect(t.metrics.board('duplicate')).toBe(2);

    await t.deliver(t.projector(BoardProjector), [
      t.paid({
        paidAt: at(0),
        lines: [{ shopId: beta.shopId, productId: cable, lineTotalMinor: 1 }],
      }),
    ]);
    expect((await list()).map((e) => e.name)).toEqual(['Beta', 'Alpha']);
    expect(
      (await list('period=week&category=accessories')).map((e) => e.name),
    ).toEqual(['Beta']);
    expect(await list('period=month&category=electronics')).toHaveLength(2);
    const rank = shopRankSchema.parse(
      (
        await t
          .as(alpha.owner)
          .get(`/api/shops/${alpha.shopId}/rank?period=week`)
          .expect(200)
      ).body,
    );
    expect(rank).toMatchObject({
      rank: 2,
      of: 2,
      topPercent: 100,
      revenueMinor: 10_000,
    });
  });

  it('S40 AS-01: a discounted line counts what was paid (lineTotalMinor), not price times quantity', async () => {
    const alpha = await t.seedShop({ name: 'Alpha' });
    const phone = await t.product(alpha.shopId, 'electronics');
    await t.deliver(t.projector(BoardProjector), [
      t.paid({
        paidAt: T0,
        lines: [
          {
            shopId: alpha.shopId,
            productId: phone,
            quantity: 2,
            unitPriceMinor: 10_000,
            discountMinor: 3_000,
            lineTotalMinor: 17_000,
          },
        ],
      }),
    ]);

    expect(await t.board(t.week(), 'all')).toEqual([
      { shopId: alpha.shopId, revenueMinor: 17_000 },
    ]);
    const rank = shopRankSchema.parse(
      (
        await t
          .as(alpha.owner)
          .get(`/api/shops/${alpha.shopId}/rank?period=week`)
          .expect(200)
      ).body,
    );
    expect(rank.revenueMinor).toBe(17_000);
  });

  it('S40 AS-22: a closed period is served from the PostgreSQL snapshot after Redis forgets it', async () => {
    const alpha = await t.readModelShop('Alpha');
    const phone = await t.product(alpha.shopId, 'electronics');
    await t.deliver(t.projector(BoardProjector), [
      t.paid({
        paidAt: '2026-10-02T10:00:00Z',
        lines: [
          { shopId: alpha.shopId, productId: phone, lineTotalMinor: 5_000 },
        ],
      }),
    ]);
    t.clock.set(new Date('2026-10-05T01:00:00Z'));

    const results = await t.runSnapshotJob('week');
    t.clock.set(T0);

    expect(results).toEqual([{ periodId: '2026-W40', boards: 2, rows: 2 }]); // the overall and the electronics board
    await t.flushRedisPrefix('lb:{2026-W40}');
    const page = leaderboardPageSchema.parse(
      (
        await t
          .http()
          .get('/api/leaderboards?period=week&id=2026-W40')
          .expect(200)
      ).body,
    );
    expect(page.source).toBe('snapshot');
    expect(page.entries).toEqual([
      { rank: 1, shopId: alpha.shopId, slug: alpha.slug, name: 'Alpha' },
    ]);
  });

  it('S40 AS-37: the live window sums the last 60 one-second buckets: checkouts, orders, revenue, conversion', async () => {
    const shop = await t.seedShop();
    const second = Math.floor(T0.getTime() / 1000);
    const reserve = () =>
      t.reserved({ shopIds: [shop.shopId] }, { occurredAt: T0 });
    const paid = t.paid({
      paidAt: T0,
      lines: [
        {
          shopId: shop.shopId,
          productId: uuidv4(),
          quantity: 2,
          lineTotalMinor: 5_000,
        },
      ],
    });
    await t.deliver(t.projector(LiveProjector), [
      reserve(),
      reserve(),
      reserve(),
      reserve(),
      paid,
    ]);
    await t.deliver(t.projector(LiveProjector), [paid]); // replay
    const stream = t.subscribe(shop.owner, shop.shopId, {
      count: 1,
      timeoutMs: 5000,
    });
    await t.waitForSubscriber(shop.shopId);

    await t.ticker.tick(second);

    const result = await stream;
    expect(result.status).toBe(200);
    expect(result.events).toHaveLength(1);
    const frame = liveDashboardFrameSchema.parse(
      JSON.parse(result.events[0].data!).data,
    );
    expect(frame.shopId).toBe(shop.shopId);
    expect(frame.at).toBe(second);
    expect(frame.last60s).toEqual({
      checkouts: 4,
      orders: 1,
      units: 2,
      revenueMinor: 5_000,
    });
    expect(frame.checkoutConversion).toBe(0.25);
    expect(frame.ordersPerSecond).toHaveLength(60);
    expect(frame.ordersPerSecond[59]).toBe(1);
  });
});
