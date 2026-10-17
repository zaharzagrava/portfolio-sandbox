import { v4 as uuidv4 } from 'uuid';
import { leaderboardPageSchema } from '@marketplace-sandbox/contracts';
import type { Projector } from '@app/infrastructure/projections/projector';
import { BoardProjector } from './infra/projectors/board.projector';
import { LiveProjector } from './infra/projectors/live.projector';
import { ProductCategoryProjector } from './infra/projectors/read-model.projectors';
import { SalesProjector } from './infra/projectors/sales.projector';
import {
  createInsightsApp,
  T0,
  type InsightsTestApp,
} from './testing/insights-fixtures';

describe('Leaderboards: board feed (idempotency, ties, periods, replay, limits)', () => {
  let t: InsightsTestApp;

  beforeAll(async () => {
    t = await createInsightsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const at = (offsetSeconds: number) =>
    new Date(T0.getTime() + offsetSeconds * 1000);
  const boards = () => t.projector(BoardProjector);
  const week = () => t.week();
  const month = () => t.month();
  /** The shops of a board in rank order with their revenue. */
  const ranked = async (period = week(), board = 'all') =>
    (await t.board(period, board)).map(
      (e) => [e.shopId, e.revenueMinor] as const,
    );
  /** The top list as an anonymous caller sees it. */
  const topList = async (query = 'period=week') => {
    const res = await t.http().get(`/api/leaderboards?${query}`).expect(200);
    return leaderboardPageSchema.parse(res.body).entries.map((e) => e.shopId);
  };
  const order = (
    paidAt: Date | string,
    lines: Array<{
      shopId: string;
      productId: string;
      total: number;
      quantity?: number;
      discount?: number;
    }>,
  ) =>
    t.paid({
      paidAt,
      lines: lines.map((l) => ({
        shopId: l.shopId,
        productId: l.productId,
        lineTotalMinor: l.total,
        quantity: l.quantity,
        discountMinor: l.discount,
      })),
    });

  describe('AS-01..03: a paid order lands once on every board it belongs to', () => {
    it('S40 AS-01: O1 puts 6000 / 5000 / 1000 on the overall, electronics and accessories boards of the week and the month, from lineTotalMinor', async () => {
      const a = await t.readModelShop('Alpha');
      const p1 = await t.product(a.shopId, 'electronics');
      const p2 = await t.product(a.shopId, 'accessories');
      const o1 = t.paid({
        paidAt: T0,
        lines: [
          {
            productId: p1,
            shopId: a.shopId,
            quantity: 2,
            unitPriceMinor: 3000,
            discountMinor: 1000,
            lineTotalMinor: 5000,
          },
          {
            productId: p2,
            shopId: a.shopId,
            quantity: 1,
            unitPriceMinor: 1000,
            discountMinor: 0,
            lineTotalMinor: 1000,
          },
        ],
      });

      const result = await t.deliver(boards(), [o1]);

      expect(result.deadLettered).toEqual([]);
      for (const period of [week(), month()]) {
        expect(await ranked(period, 'all')).toEqual([[a.shopId, 6000]]);
        expect(await ranked(period, 'cat:electronics')).toEqual([
          [a.shopId, 5000],
        ]);
        expect(await ranked(period, 'cat:accessories')).toEqual([
          [a.shopId, 1000],
        ]);
      }
      expect(await ranked(t.week('2026-W40'))).toEqual([]);
      expect(await ranked(t.month('2026-09'))).toEqual([]);
      expect(t.metrics.board('applied')).toBe(2);
    });

    it('S40 AS-02: redelivery once, twice at once and ten times at once changes no figure; duplicate counts 26', async () => {
      const a = await t.readModelShop('Alpha');
      const p1 = await t.product(a.shopId, 'electronics');
      const p2 = await t.product(a.shopId, 'accessories');
      const o1 = order(T0, [
        { shopId: a.shopId, productId: p1, total: 5000 },
        { shopId: a.shopId, productId: p2, total: 1000 },
      ]);
      await t.deliver(boards(), [o1]);

      await t.deliver(boards(), [o1]);
      expect(
        (
          await Promise.all([
            t.deliver(boards(), [o1]),
            t.deliver(boards(), [o1]),
          ])
        ).flatMap((r) => r.deadLettered),
      ).toEqual([]);
      expect(
        (
          await Promise.all(
            Array.from({ length: 10 }, () => t.deliver(boards(), [o1])),
          )
        ).flatMap((r) => r.deadLettered),
      ).toEqual([]);

      expect(await ranked(week(), 'all')).toEqual([[a.shopId, 6000]]);
      expect(await ranked(week(), 'cat:electronics')).toEqual([
        [a.shopId, 5000],
      ]);
      expect(await ranked(month(), 'cat:accessories')).toEqual([
        [a.shopId, 1000],
      ]);
      expect(t.metrics.board('applied')).toBe(2);
      expect(t.metrics.board('duplicate')).toBe(26);
    });

    it('S40 AS-03: 50 orders of 100 from one shop, consumed by 10 parallel workers, add up to exactly 5000 with one entry per board', async () => {
      const a = await t.readModelShop('Alpha');
      const p1 = await t.product(a.shopId, 'electronics');
      const orders = Array.from({ length: 50 }, () =>
        order(T0, [{ shopId: a.shopId, productId: p1, total: 100 }]),
      );
      const workers = Array.from({ length: 10 }, (_, i) =>
        orders.slice(i * 5, i * 5 + 5),
      );

      const results = await Promise.all(
        workers.map((batch) => t.deliver(boards(), batch)),
      );

      expect(results.flatMap((r) => r.deadLettered)).toEqual([]);
      expect(await ranked(week(), 'all')).toEqual([[a.shopId, 5000]]);
      expect(await ranked(week(), 'cat:electronics')).toEqual([
        [a.shopId, 5000],
      ]);
      expect(await t.redis.zcard(`lb:{${week().id}}:z:all`)).toBe(1);
      expect(await t.redis.zcard(`lb:{${week().id}}:z:cat:electronics`)).toBe(
        1,
      );
      expect(t.metrics.board('applied')).toBe(100);
    });
  });

  describe('AS-04..06: ties and the last-sale instant', () => {
    it('S40 AS-04: at equal revenue the shop that reached it first ranks first', async () => {
      const [a, b] = [
        await t.readModelShop('Alpha'),
        await t.readModelShop('Beta'),
      ];
      const p = await t.product(a.shopId, 'electronics');
      await t.deliver(boards(), [
        order(at(-60), [{ shopId: a.shopId, productId: p, total: 10_000 }]),
      ]);
      await t.deliver(boards(), [
        order(at(-30), [{ shopId: b.shopId, productId: p, total: 10_000 }]),
      ]);
      expect(await topList()).toEqual([a.shopId, b.shopId]);

      await t.deliver(boards(), [
        order(at(0), [{ shopId: b.shopId, productId: p, total: 1 }]),
      ]);
      expect(await topList()).toEqual([b.shopId, a.shopId]);
      expect(await ranked()).toEqual([
        [b.shopId, 10_001],
        [a.shopId, 10_000],
      ]);

      await t.deliver(boards(), [
        order(at(10), [{ shopId: a.shopId, productId: p, total: 1 }]),
      ]);
      expect(await topList()).toEqual([b.shopId, a.shopId]);
      expect(await ranked()).toEqual([
        [b.shopId, 10_001],
        [a.shopId, 10_001],
      ]);
    });

    it('S40 AS-05: delivery order never moves the last-sale instant back; both orders give the same board entry for entry', async () => {
      const [a, b] = [
        await t.readModelShop('Alpha'),
        await t.readModelShop('Beta'),
      ];
      const p = await t.product(a.shopId, 'electronics');
      const week40 = 7 * 86_400;
      const events = (shift: number) => ({
        bFirst: order(at(-300 - shift), [
          { shopId: b.shopId, productId: p, total: 10_500 },
        ]),
        aNew: order(at(0 - shift), [
          { shopId: a.shopId, productId: p, total: 10_000 },
        ]),
        aOld: order(at(-600 - shift), [
          { shopId: a.shopId, productId: p, total: 500 },
        ]),
      });
      const current = events(0);
      await t.deliver(boards(), [current.bFirst]);
      await t.deliver(boards(), [current.aNew]);
      await t.deliver(boards(), [current.aOld]);
      expect(await ranked()).toEqual([
        [b.shopId, 10_500],
        [a.shopId, 10_500],
      ]);
      expect(await topList()).toEqual([b.shopId, a.shopId]);

      // the same sales a week earlier, consumed in the opposite order, on an empty week
      const earlier = events(week40);
      await t.deliver(boards(), [earlier.aOld]);
      await t.deliver(boards(), [earlier.aNew]);
      await t.deliver(boards(), [earlier.bFirst]);
      const previous = t.week('2026-W40');
      expect(await ranked(previous)).toEqual(await ranked());
      expect(
        await t.redis.zrevrange(
          `lb:{${previous.id}}:z:all`,
          0,
          -1,
          'WITHSCORES',
        ),
      ).toEqual(
        await t.redis.zrevrange(`lb:{${week().id}}:z:all`, 0, -1, 'WITHSCORES'),
      );
    });

    it('S40 AS-06: equal revenue in the same second ranks the larger shop id first; the same order on every read', async () => {
      const [a, b, c] = await t.trio();
      const p = await t.product(a.shopId, 'electronics');
      await t.deliver(boards(), [
        order(at(10), [{ shopId: a.shopId, productId: p, total: 7000 }]),
        order(at(50), [{ shopId: b.shopId, productId: p, total: 7000 }]),
        order(at(50), [{ shopId: c.shopId, productId: p, total: 7000 }]),
      ]);

      for (let i = 0; i < 10; i++) {
        expect(await topList('period=week')).toEqual([
          a.shopId,
          c.shopId,
          b.shopId,
        ]);
        expect(await topList('period=month')).toEqual([
          c.shopId,
          b.shopId,
          a.shopId,
        ]);
      }
      const rank = async (shop: typeof a, period: string) =>
        (
          await t
            .as(shop.owner)
            .get(`/api/shops/${shop.shopId}/rank?period=${period}`)
            .expect(200)
        ).body.rank;
      for (let i = 0; i < 3; i++) {
        expect([
          await rank(a, 'week'),
          await rank(c, 'week'),
          await rank(b, 'week'),
        ]).toEqual([1, 2, 3]);
        expect([
          await rank(c, 'month'),
          await rank(b, 'month'),
          await rank(a, 'month'),
        ]).toEqual([1, 2, 3]);
      }
    });
  });

  describe('AS-08..09: periods and frozen periods', () => {
    it('S40 AS-08: a late event of a closed, unfrozen week counts for that week and its month, not for the current week', async () => {
      const a = await t.readModelShop('Alpha');
      const p = await t.product(a.shopId, 'electronics');

      await t.deliver(boards(), [
        order('2026-10-04T10:00:00Z', [
          { shopId: a.shopId, productId: p, total: 700 },
        ]),
      ]);

      expect(await ranked(t.week('2026-W40'))).toEqual([[a.shopId, 700]]);
      expect(await ranked(t.month('2026-10'))).toEqual([[a.shopId, 700]]);
      expect(await ranked(t.week('2026-W41'))).toEqual([]);
    });

    it('S40 AS-09: an event for a frozen week is acknowledged without being applied; the month counts it; one warning names the order and the period', async () => {
      const a = await t.readModelShop('Alpha');
      const p = await t.product(a.shopId, 'electronics');
      await t.deliver(boards(), [
        order('2026-10-04T09:00:00Z', [
          { shopId: a.shopId, productId: p, total: 10_000 },
        ]),
      ]);
      t.clock.set(new Date('2026-10-05T01:00:00Z'));
      await t.freeze('2026-W40');
      t.clock.set(T0);
      const base = {
        applied: t.metrics.board('applied'),
        sealed: t.metrics.board('sealed'),
      };
      const late = order('2026-10-04T10:00:00Z', [
        { shopId: a.shopId, productId: p, total: 500 },
      ]);

      const result = await t.deliver(boards(), [late]);

      expect(result.deadLettered).toEqual([]);
      expect(await ranked(t.week('2026-W40'))).toEqual([[a.shopId, 10_000]]);
      expect(await ranked(t.month('2026-10'))).toEqual([[a.shopId, 10_500]]);
      expect(t.metrics.board('sealed') - base.sealed).toBe(1);
      expect(t.metrics.board('applied') - base.applied).toBe(1);
      const warnings = t
        .logs()
        .filter((l) => l.level === 'warn' && l.line.event === 'period_sealed');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].line).toMatchObject({
        orderId: late.payload.orderId,
        period: '2026-W40',
      });
      expect(
        warnings[0].line.traceId ?? warnings[0].line.requestId,
      ).toBeTruthy();
    });
  });

  describe('AS-10: invalid and unsupported payloads', () => {
    it('S40 AS-10: each bad message is dead-lettered with a reason and changes nothing; the next valid one is applied; a foreign type is ignored', async () => {
      const a = await t.readModelShop('Alpha');
      const p = await t.product(a.shopId, 'electronics');
      const line = (over: Record<string, unknown> = {}) => ({
        productId: p,
        shopId: a.shopId,
        title: 'Item',
        quantity: 1,
        unitPriceMinor: 100,
        discountMinor: 0,
        lineTotalMinor: 100,
        ...over,
      });
      const payload = (over: Record<string, unknown> = {}) => {
        const orderId = uuidv4();
        return {
          orderId,
          userId: 'u1',
          orderVersion: 2,
          totalMinor: 100,
          currency: 'EUR',
          paymentRef: 'pay',
          paidAt: T0.toISOString(),
          lines: [line()],
          shopOrders: [],
          ...over,
        };
      };
      const raw = (body: Record<string, unknown>, version = 1) =>
        t.raw(
          'order.paid',
          'orders',
          (body.orderId as string) ?? uuidv4(),
          body,
          { version },
        );
      const { orderId: _drop, ...withoutOrderId } = payload();
      const bad = [
        raw(withoutOrderId),
        raw(payload({ paidAt: 'yesterday afternoon' })),
        raw(payload({ lines: [] })),
        raw(payload({ lines: [line({ lineTotalMinor: 10.5 })] })),
        raw(payload({ lines: [line({ shopId: 'not-a-uuid' })] })),
        raw(payload({ currency: 'USD' })),
        raw(payload(), 2),
      ];
      const valid = order(T0, [{ shopId: a.shopId, productId: p, total: 250 }]);
      const foreign = t.raw('order.cancelled', 'orders', uuidv4(), {
        orderId: uuidv4(),
        reason: 'user_cancelled',
      });

      const result = await t.deliver(boards(), [...bad, foreign, valid]);

      expect(result.deadLettered.map((d) => d.event.eventId).sort()).toEqual(
        bad.map((b) => b.eventId).sort(),
      );
      const reasons = Object.fromEntries(
        result.deadLettered.map((d) => [d.event.eventId, d.reason]),
      );
      expect(bad.slice(0, 5).map((b) => reasons[b.eventId])).toEqual(
        Array(5).fill('invalid_payload'),
      );
      expect(reasons[bad[5].eventId]).toBe('unsupported_currency');
      expect(reasons[bad[6].eventId]).toBe('UNSUPPORTED_VERSION');
      expect(await ranked(week())).toEqual([[a.shopId, 250]]);
      expect(await ranked(month())).toEqual([[a.shopId, 250]]);
      expect(t.metrics.board('rejected')).toBe(6);
    });

    it('S40 AS-10: the live and the history consumers dead-letter the same bad messages and apply the next valid one', async () => {
      const a = await t.readModelShop('Alpha');
      const p = await t.product(a.shopId, 'electronics');
      const body = (over: Record<string, unknown>) => ({
        orderId: uuidv4(),
        userId: 'u1',
        orderVersion: 2,
        totalMinor: 100,
        currency: 'EUR',
        paymentRef: 'pay',
        paidAt: T0.toISOString(),
        lines: [
          {
            productId: p,
            shopId: a.shopId,
            title: 'Item',
            quantity: 1,
            unitPriceMinor: 100,
            discountMinor: 0,
            lineTotalMinor: 100,
          },
        ],
        shopOrders: [],
        ...over,
      });
      const bad = [
        t.raw('order.paid', 'orders', uuidv4(), body({ lines: [] })),
        t.raw('order.paid', 'orders', uuidv4(), body({ currency: 'USD' })),
        t.raw('order.paid', 'orders', uuidv4(), body({ paidAt: 'soon' })),
      ];
      const valid = order(T0, [{ shopId: a.shopId, productId: p, total: 400 }]);

      for (const consumer of [LiveProjector, SalesProjector]) {
        const result = await t.deliver(t.projector<Projector>(consumer), [
          ...bad,
          valid,
        ]);
        expect(result.deadLettered.map((d) => d.event.eventId).sort()).toEqual(
          bad.map((b) => b.eventId).sort(),
        );
      }

      const second = Math.floor(T0.getTime() / 1000);
      const live = await t.counters().window(a.shopId, second);
      expect(live.reduce((n, b) => n + b.revenue, 0)).toBe(400);
      expect(
        await t.sql(
          `SELECT sum(line_total_minor) AS n FROM shop_sale_facts WHERE shop_id = {id:String}`,
          { id: a.shopId },
        ),
      ).toEqual([{ n: '400' }]);
    });
  });

  describe('AS-11: categories from the read model', () => {
    it('S40 AS-11: an unknown product counts on the overall board only, is not re-attributed later, and a category follows its newest version', async () => {
      const a = await t.readModelShop('Alpha');
      const p3 = uuidv4();
      const sale = (amount: number) =>
        order(T0, [{ shopId: a.shopId, productId: p3, total: amount }]);

      await t.deliver(boards(), [sale(3000)]);
      expect(await ranked(week(), 'all')).toEqual([[a.shopId, 3000]]);
      expect(
        await t
          .boardKeys()
          .then((k) => k.filter((x) => x.key.includes(':z:cat:'))),
      ).toEqual([]);
      expect(t.metrics.board('category_unresolved')).toBe(1);

      const category = t.projector(ProductCategoryProjector);
      await t.deliver(category, [
        t.productEvent('created', {
          productId: p3,
          shopId: a.shopId,
          category: 'phones',
          productVersion: 1,
        }),
      ]);
      await t.deliver(boards(), [sale(1000)]);
      expect(await ranked(week(), 'all')).toEqual([[a.shopId, 4000]]);
      expect(await ranked(week(), 'cat:phones')).toEqual([[a.shopId, 1000]]);

      await t.deliver(category, [
        t.productEvent('updated', {
          productId: p3,
          shopId: a.shopId,
          category: 'gadgets',
          productVersion: 2,
        }),
      ]);
      await t.deliver(boards(), [sale(500)]);
      expect(await ranked(week(), 'cat:gadgets')).toEqual([[a.shopId, 500]]);
      expect(await ranked(week(), 'cat:phones')).toEqual([[a.shopId, 1000]]);

      await t.deliver(category, [
        t.productEvent('updated', {
          productId: p3,
          shopId: a.shopId,
          category: 'toys',
          productVersion: 1,
        }),
      ]);
      await t.deliver(boards(), [sale(100)]);
      expect(await ranked(week(), 'cat:gadgets')).toEqual([[a.shopId, 600]]);
      expect(await ranked(week(), 'cat:toys')).toEqual([]);
      expect(t.metrics.board('category_unresolved')).toBe(1);
    });
  });

  describe('AS-12: rebuild by replay', () => {
    it('S40 AS-12: 200 events, board store emptied, replayed shuffled twice (duplicates), give byte-equal boards', async () => {
      const shops = await Promise.all(
        ['Alpha', 'Beta', 'Gamma'].map((n) => t.readModelShop(n)),
      );
      const products = [
        await t.product(shops[0].shopId, 'electronics'),
        await t.product(shops[0].shopId, 'accessories'),
      ];
      const instants = [
        '2026-09-30T10:00:00Z',
        '2026-10-02T09:30:00Z',
        '2026-10-06T08:00:00Z',
        '2026-10-06T08:00:30Z',
        '2026-10-08T17:45:10Z',
      ];
      const amounts = [100, 250, 250, 700, 1000];
      const events = Array.from({ length: 200 }, (_, i) =>
        order(instants[(i * 7) % instants.length], [
          {
            shopId: shops[i % 3].shopId,
            productId: products[i % 2],
            total: amounts[(i * 3) % amounts.length],
          },
        ]),
      );
      for (let i = 0; i < events.length; i += 20)
        await t.deliver(boards(), events.slice(i, i + 20));
      const periods = [
        t.week('2026-W40'),
        t.week('2026-W41'),
        t.month('2026-09'),
        t.month('2026-10'),
      ];
      const names = ['all', 'cat:electronics', 'cat:accessories'];
      const snapshot = async () =>
        Object.fromEntries(
          await Promise.all(
            periods.flatMap((p) =>
              names.map(
                async (n) =>
                  [
                    `${p.id}/${n}`,
                    await t.redis.zrevrange(
                      `lb:{${p.id}}:z:${n}`,
                      0,
                      -1,
                      'WITHSCORES',
                    ),
                  ] as const,
              ),
            ),
          ),
        );
      const recorded = await snapshot();
      expect(Object.values(recorded).some((v) => v.length > 0)).toBe(true);

      await t.flushRedisPrefix('lb:');
      expect(Object.values(await snapshot()).every((v) => v.length === 0)).toBe(
        true,
      );
      let seed = 42;
      const shuffled = () => {
        const copy = [...events];
        for (let i = copy.length - 1; i > 0; i--) {
          seed = (seed * 1103515245 + 12345) % 2 ** 31;
          const j = seed % (i + 1);
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
      };
      for (const pass of [shuffled(), shuffled()])
        for (let i = 0; i < pass.length; i += 25)
          await t.deliver(boards(), pass.slice(i, i + 25));

      expect(await snapshot()).toEqual(recorded);
    });
  });

  describe('AS-13: all boards of an order, or none', () => {
    it('S40 AS-13: an order that would pass the revenue ceiling is dead-lettered whole and no board changes', async () => {
      const a = await t.readModelShop('Alpha');
      const other = await t.product(a.shopId, 'garden');
      const electronics = await t.product(a.shopId, 'electronics');
      const accessories = await t.product(a.shopId, 'accessories');
      await t.deliver(boards(), [
        order(T0, [
          { shopId: a.shopId, productId: other, total: 8_589_934_000 },
        ]),
      ]);
      const before = await t.redis.zrevrange(
        `lb:{${week().id}}:z:all`,
        0,
        -1,
        'WITHSCORES',
      );
      const over = order(T0, [
        { shopId: a.shopId, productId: electronics, total: 300 },
        { shopId: a.shopId, productId: accessories, total: 300 },
      ]);

      const result = await t.deliver(boards(), [over]);

      expect(
        result.deadLettered.map((d) => [d.event.eventId, d.reason]),
      ).toEqual([[over.eventId, 'revenue_limit_exceeded']]);
      expect(
        await t.redis.zrevrange(`lb:{${week().id}}:z:all`, 0, -1, 'WITHSCORES'),
      ).toEqual(before);
      expect(await ranked(week(), 'cat:electronics')).toEqual([]);
      expect(await ranked(week(), 'cat:accessories')).toEqual([]);
      expect(await ranked(week(), 'all')).toEqual([[a.shopId, 8_589_934_000]]);
      expect(
        await t.redis.sismember(
          `lb:{${week().id}}:applied`,
          over.payload.orderId as string,
        ),
      ).toBe(0);
    });
  });

  describe('AS-15: zero-revenue orders', () => {
    it('S40 AS-15: a fully discounted order adds no entry; a later order of 1 adds the shop with 1', async () => {
      const a = await t.readModelShop('Alpha');
      const p = await t.product(a.shopId, 'electronics');

      await t.deliver(boards(), [
        order(T0, [
          { shopId: a.shopId, productId: p, total: 0, discount: 500 },
        ]),
      ]);
      expect(await ranked(week(), 'all')).toEqual([]);
      expect(await ranked(month(), 'cat:electronics')).toEqual([]);

      await t.deliver(boards(), [
        order(T0, [{ shopId: a.shopId, productId: p, total: 1 }]),
      ]);
      expect(await ranked(week(), 'all')).toEqual([[a.shopId, 1]]);
    });
  });

  describe('AS-16: retention', () => {
    it('S40 AS-16: every key of a period expires at its end plus 35 days (within 1 s) and none lacks an expiry', async () => {
      const a = await t.readModelShop('Alpha');
      const p = await t.product(a.shopId, 'electronics');
      await t.deliver(boards(), [
        order(T0, [{ shopId: a.shopId, productId: p, total: 100 }]),
      ]);
      await t.deliver(boards(), [
        order('2026-10-04T10:00:00Z', [
          { shopId: a.shopId, productId: p, total: 100 },
        ]),
      ]);

      const keys = await t.boardKeys();
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((k) => k.ttlMs < 0)).toEqual([]);
      const expectedMs = (periodId: string, end: Date) => {
        const matching = keys.filter((k) =>
          k.key.startsWith(`lb:{${periodId}}:`),
        );
        expect(matching.length).toBeGreaterThan(0);
        return {
          matching,
          ttl: end.getTime() + 35 * 86_400_000 - T0.getTime(),
        };
      };
      for (const [id, end] of [
        [week().id, week().end],
        [month().id, month().end],
        ['2026-W40', t.week('2026-W40').end],
      ] as const) {
        const { matching, ttl } = expectedMs(id, end);
        for (const k of matching)
          expect(Math.abs(k.ttlMs - ttl)).toBeLessThanOrEqual(1000);
      }
      // its key families: boards, revenue totals, de-duplication marks, board lists
      const families = new Set(
        keys
          .filter((k) => k.key.startsWith(`lb:{${week().id}}:`))
          .map((k) => k.key.split('}:')[1].split(':')[0]),
      );
      expect(families).toEqual(
        new Set(['z', 'rev', 'last', 'applied', 'boards']),
      );
    });
  });
});
