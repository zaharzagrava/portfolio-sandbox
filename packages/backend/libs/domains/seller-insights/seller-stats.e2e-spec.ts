import { v4 as uuidv4 } from 'uuid';
import {
  dashboardTodaySchema,
  sellerStatsSchema,
} from '@marketplace-sandbox/contracts';
import { BoardProjector } from './infra/projectors/board.projector';
import { LiveProjector } from './infra/projectors/live.projector';
import { RefundProjector } from './infra/projectors/refund.projector';
import { SalesProjector } from './infra/projectors/sales.projector';
import {
  SALES_HISTORY_REPOSITORY,
  type SalesHistoryRepository,
} from './domain/ports';
import {
  createInsightsApp,
  T0,
  type InsightsTestApp,
} from './testing/insights-fixtures';

describe('Seller stats: summary, refunds, windows and isolation', () => {
  let t: InsightsTestApp;

  beforeAll(async () => {
    t = await createInsightsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const sales = () => t.projector(SalesProjector);
  const refunds = () => t.projector(RefundProjector);
  const strip = (body: Record<string, unknown>) => {
    const { instance: _i, requestId: _r, ...rest } = body;
    return rest;
  };
  const stats = (user: { bearer: string }, shopId: string, query = 'days=7') =>
    t
      .http()
      .get(`/api/shops/${shopId}/stats?${query}`)
      .set('Authorization', user.bearer);
  const order = (
    shopId: string,
    paidAt: string,
    lines: Array<{
      productId: string;
      total: number;
      quantity?: number;
      title?: string;
    }>,
    userId = 'buyer-1',
    orderId = uuidv4(),
  ) =>
    t.paid({
      orderId,
      userId,
      paidAt,
      lines: lines.map((l) => ({
        shopId,
        productId: l.productId,
        lineTotalMinor: l.total,
        quantity: l.quantity,
        title: l.title,
      })),
    });

  describe('AS-50: stats', () => {
    it('S40 AS-50: revenue, orders, units, unique buyers, refunds, a zero-filled week and the top products, with no buyer identity', async () => {
      const shop = await t.seedShop();
      const [p1, p2] = [uuidv4(), uuidv4()];
      const o1 = order(
        shop.shopId,
        '2026-10-06T09:00:00Z',
        [
          { productId: p1, total: 3000, title: 'Phone' },
          { productId: p2, total: 2000, quantity: 2, title: 'Cable' },
        ],
        'buyer-U1',
      );
      const o2 = order(
        shop.shopId,
        '2026-10-06T10:00:00Z',
        [{ productId: p1, total: 1000, title: 'Phone' }],
        'buyer-U1',
      );
      const o3 = order(
        shop.shopId,
        '2026-10-05T10:00:00Z',
        [{ productId: p1, total: 3000, title: 'Phone' }],
        'buyer-U2',
      );
      await t.deliver(sales(), [o1, o2, o3]);
      await t.deliver(refunds(), [
        t.refunded(
          { orderId: o3.payload.orderId as string, amountMinor: 3000 },
          { occurredAt: new Date('2026-10-06T11:00:00Z') },
        ),
      ]);

      const res = await stats(shop.owner, shop.shopId).expect(200);

      const body = sellerStatsSchema.parse(res.body);
      expect(body).toMatchObject({
        shopId: shop.shopId,
        days: 7,
        from: '2026-09-30',
        to: '2026-10-06',
        currency: 'EUR',
        summary: {
          revenueMinor: 9000,
          orders: 3,
          unitsSold: 5,
          uniqueBuyers: 2,
          refundsCount: 1,
          refundedMinor: 3000,
          netRevenueMinor: 6000,
          avgOrderValueMinor: 3000,
        },
      });
      expect(body.daily.map((d) => d.day)).toEqual([
        '2026-09-30',
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
        '2026-10-04',
        '2026-10-05',
        '2026-10-06',
      ]);
      expect(
        body.daily
          .slice(0, 5)
          .every(
            (d) =>
              d.revenueMinor === 0 && d.orders === 0 && d.refundedMinor === 0,
          ),
      ).toBe(true);
      expect(body.daily[5]).toEqual({
        day: '2026-10-05',
        revenueMinor: 3000,
        orders: 1,
        refundedMinor: 0,
      });
      expect(body.daily[6]).toEqual({
        day: '2026-10-06',
        revenueMinor: 6000,
        orders: 2,
        refundedMinor: 3000,
      });
      expect(body.topProducts).toEqual([
        { productId: p1, title: 'Phone', revenueMinor: 7000, unitsSold: 3 },
        { productId: p2, title: 'Cable', revenueMinor: 2000, unitsSold: 2 },
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/buyer-U|userId/);
    });
  });

  describe('AS-51: validation', () => {
    it('S40 AS-51: every invalid days is a 400 naming the field; days defaults to 30; 1 and 365 are accepted', async () => {
      const shop = await t.seedShop();
      for (const query of [
        'days=0',
        'days=366',
        'days=-1',
        'days=abc',
        'days=1.5',
        'days=',
        'days=1&days=2',
      ]) {
        const res = await stats(shop.owner, shop.shopId, query);
        expect([query, res.status, res.body.code]).toEqual([
          query,
          400,
          'validation_failed',
        ]);
        expect(
          res.body.errors.map((e: { field: string }) => e.field),
        ).toContain('days');
      }
      const unknown = await stats(shop.owner, shop.shopId, 'surprise=1');
      expect([unknown.status, unknown.body.code]).toEqual([
        400,
        'validation_failed',
      ]);
      expect(
        unknown.body.errors.map((e: { field: string }) => e.field),
      ).toContain('surprise');

      const normal = sellerStatsSchema.parse(
        (await stats(shop.owner, shop.shopId, '').expect(200)).body,
      );
      expect([normal.days, normal.daily.length, normal.from]).toEqual([
        30,
        30,
        '2026-09-07',
      ]);
      expect(
        sellerStatsSchema.parse(
          (await stats(shop.owner, shop.shopId, 'days=1').expect(200)).body,
        ).daily,
      ).toHaveLength(1);
      expect(
        sellerStatsSchema.parse(
          (await stats(shop.owner, shop.shopId, 'days=365').expect(200)).body,
        ).daily,
      ).toHaveLength(365);
    });
  });

  describe('AS-52: access and isolation', () => {
    it('S40 AS-52: a stranger gets the same 404 as an unknown shop; no credentials is 401; a viewer gets 200; shops never mix', async () => {
      const [s1, s2] = [await t.seedShop(), await t.seedShop()];
      await t.deliver(sales(), [
        order(s1.shopId, '2026-10-06T08:00:00Z', [
          { productId: uuidv4(), total: 500 },
        ]),
        order(s2.shopId, '2026-10-06T08:00:00Z', [
          { productId: uuidv4(), total: 123_456 },
        ]),
      ]);

      const foreign = await stats(s1.owner, s2.shopId);
      const unknown = await stats(s1.owner, uuidv4());

      expect([foreign.status, unknown.status]).toEqual([404, 404]);
      expect(strip(unknown.body)).toEqual(strip(foreign.body));
      expect(foreign.body.code).toBe('shop_not_found');
      expect((await t.http().get(`/api/shops/${s1.shopId}/stats`)).status).toBe(
        401,
      );
      const viewer = await t.member(s1.shopId, 'VIEWER');
      const own = sellerStatsSchema.parse(
        (await stats(viewer, s1.shopId).expect(200)).body,
      );
      expect(own.summary).toMatchObject({ orders: 1, revenueMinor: 500 });
      expect(JSON.stringify(own)).not.toContain('123456');
    });
  });

  describe('AS-53: refunds', () => {
    it('S40 AS-53: a two-shop refund is split by each shop share on the refund day; a duplicate and concurrent deliveries change nothing', async () => {
      const [s1, s2] = [await t.seedShop(), await t.seedShop()];
      const o = t.paid({
        paidAt: '2026-10-06T08:00:00Z',
        lines: [
          { shopId: s1.shopId, productId: uuidv4(), lineTotalMinor: 3000 },
          { shopId: s2.shopId, productId: uuidv4(), lineTotalMinor: 2000 },
        ],
      });
      await t.deliver(sales(), [o]);
      const refund = t.refunded(
        { orderId: o.payload.orderId as string, amountMinor: 5000 },
        { occurredAt: new Date('2026-10-06T10:30:00Z') },
      );

      await t.deliver(refunds(), [refund]);
      await t.deliver(refunds(), [refund]);
      expect(
        (
          await Promise.all(
            Array.from({ length: 5 }, () => t.deliver(refunds(), [refund])),
          )
        ).flatMap((r) => r.deadLettered),
      ).toEqual([]);

      for (const [shop, share] of [
        [s1, 3000],
        [s2, 2000],
      ] as const) {
        const body = sellerStatsSchema.parse(
          (await stats(shop.owner, shop.shopId).expect(200)).body,
        );
        expect(body.summary).toMatchObject({
          refundsCount: 1,
          refundedMinor: share,
        });
        expect(body.daily.at(-1)).toMatchObject({
          day: '2026-10-06',
          refundedMinor: share,
        });
      }
    });

    it('S40 AS-53: a refund without a recorded sale is tried 5 times and dead-lettered; a partial amount is dead-lettered; neither changes anything, nor the boards or the live counters', async () => {
      const shop = await t.seedShop();
      const product = uuidv4();
      const sale = order(shop.shopId, T0.toISOString(), [
        { productId: product, total: 5000 },
      ]);
      await t.deliver(t.projector(BoardProjector), [sale]);
      await t.deliver(t.projector(LiveProjector), [sale]);
      await t.deliver(sales(), [sale]);
      const boardBefore = await t.redis.zrevrange(
        `lb:{2026-W41}:z:all`,
        0,
        -1,
        'WITHSCORES',
      );
      const second = Math.floor(T0.getTime() / 1000);
      const liveBefore = await t.counters().window(shop.shopId, second);
      const history = t.app.get<SalesHistoryRepository>(
        SALES_HISTORY_REPOSITORY,
        { strict: false },
      );
      const lookups = jest.spyOn(history, 'recordedShares');

      const orphan = t.refunded({ orderId: uuidv4(), amountMinor: 700 });
      const orphanResult = await t.deliver(refunds(), [orphan]);
      const partial = t.refunded({
        orderId: sale.payload.orderId as string,
        amountMinor: 1000,
      });
      const partialResult = await t.deliver(refunds(), [partial]);

      expect(orphanResult.deadLettered.map((d) => d.reason)).toEqual([
        'refund_without_sale',
      ]);
      expect(
        lookups.mock.calls.filter(([id]) => id === orphan.payload.orderId),
      ).toHaveLength(5);
      expect(partialResult.deadLettered.map((d) => d.reason)).toEqual([
        'partial_refund_unsupported',
      ]);
      lookups.mockRestore();
      expect(
        sellerStatsSchema.parse(
          (await stats(shop.owner, shop.shopId).expect(200)).body,
        ).summary,
      ).toMatchObject({
        refundsCount: 0,
        refundedMinor: 0,
        revenueMinor: 5000,
        netRevenueMinor: 5000,
      });
      expect(await t.sql(`SELECT count() AS n FROM shop_refund_facts`)).toEqual(
        [{ n: '0' }],
      );
      expect(
        await t.redis.zrevrange(`lb:{2026-W41}:z:all`, 0, -1, 'WITHSCORES'),
      ).toEqual(boardBefore);
      expect(await t.counters().window(shop.shopId, second)).toEqual(
        liveBefore,
      );
      expect(t.metrics.deadLetter('refunds', 'refund_without_sale')).toBe(1);
      expect(
        t.metrics.deadLetter('refunds', 'partial_refund_unsupported'),
      ).toBe(1);
    });
  });

  describe('AS-54: a shop without sales', () => {
    it('S40 AS-54: all figures are zero, the series is three zero days and there are no top products', async () => {
      const shop = await t.seedShop();

      const body = sellerStatsSchema.parse(
        (await stats(shop.owner, shop.shopId, 'days=3').expect(200)).body,
      );

      expect(body.summary).toEqual({
        revenueMinor: 0,
        orders: 0,
        unitsSold: 0,
        uniqueBuyers: 0,
        refundsCount: 0,
        refundedMinor: 0,
        netRevenueMinor: 0,
        avgOrderValueMinor: 0,
      });
      expect(body.daily).toEqual([
        { day: '2026-10-04', revenueMinor: 0, orders: 0, refundedMinor: 0 },
        { day: '2026-10-05', revenueMinor: 0, orders: 0, refundedMinor: 0 },
        { day: '2026-10-06', revenueMinor: 0, orders: 0, refundedMinor: 0 },
      ]);
      expect(body.topProducts).toEqual([]);
    });
  });

  describe('AS-55: every sale counted once, and rebuildable', () => {
    it('S40 AS-55: three deliveries (one after a forced merge, one concurrent) count once; after emptying the store and replaying shuffled, stats and today are identical', async () => {
      const shop = await t.seedShop();
      const products = [uuidv4(), uuidv4(), uuidv4()];
      const events = Array.from({ length: 12 }, (_, i) =>
        order(
          shop.shopId,
          `2026-10-0${1 + (i % 6)}T1${i % 10}:00:00Z`,
          [
            {
              productId: products[i % 3],
              total: 100 * (i + 1),
              quantity: 1 + (i % 2),
            },
          ],
          `buyer-${i % 5}`,
        ),
      );
      const todays = order(
        shop.shopId,
        '2026-10-06T09:15:00Z',
        [{ productId: products[0], total: 900 }],
        'buyer-9',
      );
      const refunded = [events[1], events[4]].map((e) =>
        t.refunded(
          {
            orderId: e.payload.orderId as string,
            amountMinor: e.payload.totalMinor as number,
          },
          { occurredAt: new Date('2026-10-06T10:00:00Z') },
        ),
      );
      const all = [...events, todays];

      await t.deliver(sales(), all);
      await t.forceCompaction();
      await t.deliver(sales(), all);
      await Promise.all([t.deliver(sales(), all), t.deliver(sales(), all)]);
      for (const refund of refunded) await t.deliver(refunds(), [refund]);
      await t.deliver(refunds(), refunded);
      const read = async () => ({
        stats: (await stats(shop.owner, shop.shopId, 'days=14').expect(200))
          .body,
        today: dashboardTodaySchema.parse(
          (
            await t
              .as(shop.owner)
              .get(`/api/shops/${shop.shopId}/dashboard/today`)
              .expect(200)
          ).body,
        ),
      });
      const before = await read();
      expect(before.stats.summary.orders).toBe(13);
      expect(before.stats.summary.refundsCount).toBe(2);

      await t.emptyAnalytics();
      expect((await read()).stats.summary.orders).toBe(0);
      let seed = 7;
      const shuffled = [...all];
      for (let i = shuffled.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        const j = seed % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      for (const e of shuffled) await t.deliver(sales(), [e]);
      for (const refund of [...refunded].reverse())
        await t.deliver(refunds(), [refund]);

      expect(await read()).toEqual(before);
    });
  });

  describe('AS-57: window boundaries', () => {
    it('S40 AS-57: the window is whole UTC days ending today', async () => {
      const shop = await t.seedShop();
      await t.deliver(sales(), [
        order(shop.shopId, '2026-10-05T23:59:59Z', [
          { productId: uuidv4(), total: 10 },
        ]),
        order(shop.shopId, '2026-10-06T00:00:00Z', [
          { productId: uuidv4(), total: 20 },
        ]),
        order(shop.shopId, '2026-10-04T23:59:59Z', [
          { productId: uuidv4(), total: 40 },
        ]),
      ]);
      const read = async (days: number) =>
        sellerStatsSchema.parse(
          (await stats(shop.owner, shop.shopId, `days=${days}`).expect(200))
            .body,
        );

      const one = await read(1);
      const two = await read(2);
      const three = await read(3);

      expect([
        one.from,
        one.to,
        one.summary.revenueMinor,
        one.summary.orders,
      ]).toEqual(['2026-10-06', '2026-10-06', 20, 1]);
      expect([two.from, two.summary.revenueMinor, two.summary.orders]).toEqual([
        '2026-10-05',
        30,
        2,
      ]);
      expect([
        three.from,
        three.summary.revenueMinor,
        three.summary.orders,
      ]).toEqual(['2026-10-04', 70, 3]);
    });
  });
});
