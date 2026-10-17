import { v4 as uuidv4 } from 'uuid';
import {
  dashboardTodaySchema,
  liveDashboardFrameSchema,
} from '@marketplace-sandbox/contracts';
import { LiveProjector } from './infra/projectors/live.projector';
import { SalesProjector } from './infra/projectors/sales.projector';
import {
  createInsightsApp,
  T0,
  type InsightsTestApp,
} from './testing/insights-fixtures';

describe('Live dashboard: today chart and analytics availability', () => {
  let t: InsightsTestApp;

  beforeAll(async () => {
    t = await createInsightsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const sales = () => t.projector(SalesProjector);
  const strip = (body: Record<string, unknown>) => {
    const { instance: _i, requestId: _r, ...rest } = body;
    return rest;
  };
  const today = (user: { bearer: string }, shopId: string) =>
    t
      .http()
      .get(`/api/shops/${shopId}/dashboard/today`)
      .set('Authorization', user.bearer);

  describe('AS-46: today chart', () => {
    it('S40 AS-46: four orders, the UTC day, sparse minutes, exact totals; redelivery and lines delivered in two batches change nothing', async () => {
      const shop = await t.seedShop();
      const [p1, p2, p3] = [uuidv4(), uuidv4(), uuidv4()];
      const o1 = t.paid({
        paidAt: '2026-10-06T11:58:30Z',
        lines: [
          {
            shopId: shop.shopId,
            productId: p1,
            lineTotalMinor: 1000,
            quantity: 1,
          },
          {
            shopId: shop.shopId,
            productId: p2,
            lineTotalMinor: 500,
            quantity: 2,
          },
        ],
      });
      const o2 = t.paid({
        paidAt: '2026-10-06T11:58:50Z',
        lines: [{ shopId: shop.shopId, productId: p1, lineTotalMinor: 2000 }],
      });
      const o3 = t.paid({
        paidAt: '2026-10-06T11:59:10Z',
        lines: [{ shopId: shop.shopId, productId: p3, lineTotalMinor: 700 }],
      });
      const o4 = t.paid({
        paidAt: '2026-10-05T23:59:59Z',
        lines: [{ shopId: shop.shopId, productId: p1, lineTotalMinor: 9999 }],
      });
      await t.deliver(sales(), [o1, o2, o3, o4]);

      const res = await today(shop.owner, shop.shopId).expect(200);

      expect(dashboardTodaySchema.parse(res.body)).toEqual({
        day: '2026-10-06',
        totals: { orders: 3, units: 5, revenueMinor: 4200 },
        series: [
          {
            minute: '2026-10-06T11:58:00Z',
            orders: 2,
            units: 4,
            revenueMinor: 3500,
          },
          {
            minute: '2026-10-06T11:59:00Z',
            orders: 1,
            units: 1,
            revenueMinor: 700,
          },
        ],
      });
      expect(res.headers['cache-control']).toBe('private, no-store');

      // every order again, and O1's two lines as two separate messages of the same order
      const orderId = o1.payload.orderId as string;
      const lines = o1.payload.lines as Array<Record<string, unknown>>;
      await t.deliver(sales(), [o1, o2, o3, o4]);
      await Promise.all([t.deliver(sales(), [o2]), t.deliver(sales(), [o2])]);
      await t.deliver(sales(), [
        t.raw('order.paid', 'orders', orderId, {
          ...o1.payload,
          lines: [lines[0]],
        }),
      ]);
      await t.deliver(sales(), [
        t.raw('order.paid', 'orders', orderId, {
          ...o1.payload,
          lines: [lines[1]],
        }),
      ]);
      expect((await today(shop.owner, shop.shopId).expect(200)).body).toEqual(
        res.body,
      );
    });
  });

  describe('AS-47: access', () => {
    it('S40 AS-47: a stranger, an unknown id and a malformed id get the same 404; no credentials is 401; viewer, staff and a suspended shop get 200; shops never mix', async () => {
      const [s1, s2] = [await t.seedShop(), await t.seedShop()];
      await t.deliver(sales(), [
        t.paid({
          paidAt: '2026-10-06T11:00:00Z',
          lines: [
            { shopId: s1.shopId, productId: uuidv4(), lineTotalMinor: 100 },
          ],
        }),
        t.paid({
          paidAt: '2026-10-06T11:00:00Z',
          lines: [
            { shopId: s2.shopId, productId: uuidv4(), lineTotalMinor: 77_700 },
          ],
        }),
      ]);

      const foreign = await today(s1.owner, s2.shopId);
      const unknown = await today(s1.owner, uuidv4());
      const malformed = await today(s1.owner, 'nope');

      expect([foreign.status, unknown.status, malformed.status]).toEqual([
        404, 404, 404,
      ]);
      expect(foreign.body.code).toBe('shop_not_found');
      expect(strip(unknown.body)).toEqual(strip(foreign.body));
      expect(strip(malformed.body)).toEqual(strip(foreign.body));
      expect(JSON.stringify(foreign.body)).not.toContain('77700');
      expect(
        (await t.http().get(`/api/shops/${s1.shopId}/dashboard/today`)).status,
      ).toBe(401);

      const viewer = await t.member(s1.shopId, 'VIEWER');
      const staff = await t.member(s1.shopId, 'STAFF');
      for (const user of [viewer, staff, s1.owner]) {
        const res = await today(user, s1.shopId).expect(200);
        expect(dashboardTodaySchema.parse(res.body).totals).toEqual({
          orders: 1,
          units: 1,
          revenueMinor: 100,
        });
      }
      const suspended = await t.seedShop({ status: 'SUSPENDED' });
      expect((await today(suspended.owner, suspended.shopId)).status).toBe(200);
    });
  });

  describe('AS-48: analytics store down', () => {
    it.each(['down', 'slow'] as const)(
      'S40 AS-48: with the analytics store %s, today and stats are 503 with Retry-After and a generic detail within 4 seconds, while live frames keep flowing',
      async (fault) => {
        const shop = await t.seedShop();
        await t.deliver(t.projector(LiveProjector), [
          t.paid({
            paidAt: T0,
            lines: [
              { shopId: shop.shopId, productId: uuidv4(), lineTotalMinor: 300 },
            ],
          }),
        ]);
        t.faults.analytics = fault;

        for (const path of ['dashboard/today', 'stats?days=7']) {
          const started = Date.now();
          const res = await t
            .as(shop.owner)
            .get(`/api/shops/${shop.shopId}/${path}`);
          expect([path, res.status]).toEqual([path, 503]);
          expect(Date.now() - started).toBeLessThan(4000);
          expect(res.headers['retry-after']).toBe('5');
          expect(res.body.code).toBe('service_unavailable');
          expect(JSON.stringify(res.body)).not.toMatch(
            /clickhouse|injected|ECONN|select|stack/i,
          );
        }

        const second = Math.floor(T0.getTime() / 1000);
        const stream = t.subscribe(shop.owner, shop.shopId, {
          count: 1,
          timeoutMs: 5000,
        });
        await t.waitForSubscriber(shop.shopId);
        await t.ticker.tick(second);
        const [event] = (await stream).events;
        expect(
          liveDashboardFrameSchema.parse(JSON.parse(event.data!).data).last60s
            .revenueMinor,
        ).toBe(300);
      },
    );
  });
});
