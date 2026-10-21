import { v4 as uuidv4 } from 'uuid';
import {
  liveDashboardFrameSchema,
  type LiveDashboardFrame,
} from '@marketplace-sandbox/contracts';
import { LiveProjector } from './infra/projectors/live.projector';
import { SalesProjector } from './infra/projectors/sales.projector';
import {
  createInsightsApp,
  T0,
  type InsightsTestApp,
  type TestUser,
} from './testing/insights-fixtures';

describe('Live dashboard: counters, ticker and frames', () => {
  let t: InsightsTestApp;

  beforeAll(async () => {
    t = await createInsightsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  /** The frame second `T` of the frozen clock. */
  const T = Math.floor(T0.getTime() / 1000);
  const stamp = (offsetSeconds: number) => new Date((T + offsetSeconds) * 1000);
  const live = () => t.projector(LiveProjector);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const frames = (result: {
    events: Array<{ event?: string; data?: string }>;
  }): LiveDashboardFrame[] =>
    result.events
      .filter((e) => e.event === 'dashboard')
      .map((e) => liveDashboardFrameSchema.parse(JSON.parse(e.data!).data));
  const totals = async (shopId: string, second = T) => {
    const window = await t.counters().window(shopId, second);
    return window.reduce(
      (n, b) => ({
        checkouts: n.checkouts + b.checkouts,
        orders: n.orders + b.orders,
        units: n.units + b.units,
        revenue: n.revenue + b.revenue,
      }),
      { checkouts: 0, orders: 0, units: 0, revenue: 0 },
    );
  };
  const paidAt = (
    shopId: string,
    offsetSeconds: number,
    total = 100,
    quantity = 1,
  ) =>
    t.paid({
      paidAt: stamp(offsetSeconds),
      lines: [{ shopId, productId: uuidv4(), lineTotalMinor: total, quantity }],
    });
  const reservedAt = (shopIds: Array<string | null>, offsetSeconds = 0) =>
    t.reserved({ shopIds }, { occurredAt: stamp(offsetSeconds) });
  /**
   * Opens the shop's stream and waits until the hub knows the viewer. The stream's result is returned inside a tuple:
   * an async function that returned the promise itself would wait for it.
   */
  const watch = async (
    user: TestUser,
    shopId: string,
    count: number,
    timeoutMs = 8000,
  ) => {
    const stream = t.subscribe(user, shopId, { count, timeoutMs });
    await t.waitForSubscriber(shopId);
    return [stream] as const;
  };

  describe('AS-37..39: counters', () => {
    it('S40 AS-37: four reservations and one paid order of the same second give the stated frame, parsed by the contracts schema', async () => {
      const shop = await t.seedShop();
      const reservations = Array.from({ length: 4 }, () =>
        reservedAt([shop.shopId]),
      );
      await t.deliver(live(), [
        ...reservations,
        paidAt(shop.shopId, 0, 5000, 2),
      ]);
      const [stream] = await watch(shop.owner, shop.shopId, 1);

      await t.ticker.tick(T);

      const result = await stream;
      expect(result.status).toBe(200);
      const [frame] = frames(result);
      expect(frame).toEqual({
        shopId: shop.shopId,
        at: T,
        windowSeconds: 60,
        last60s: { checkouts: 4, orders: 1, units: 2, revenueMinor: 5000 },
        ordersPerSecond: [...Array(59).fill(0), 1],
        checkoutConversion: 0.25,
      });
      expect(result.events[0].event).toBe('dashboard');
    });

    it('S40 AS-38: a paid order of two shops and a reservation naming one shop twice count once per shop', async () => {
      const [s1, s2] = [uuidv4(), uuidv4()];
      const order = t.paid({
        paidAt: stamp(0),
        lines: [
          {
            shopId: s1,
            productId: uuidv4(),
            lineTotalMinor: 3000,
            quantity: 1,
          },
          {
            shopId: s2,
            productId: uuidv4(),
            lineTotalMinor: 2000,
            quantity: 3,
          },
        ],
      });

      await t.deliver(live(), [order, reservedAt([s1, s2, s1])]);

      expect(await totals(s1)).toEqual({
        checkouts: 1,
        orders: 1,
        units: 1,
        revenue: 3000,
      });
      expect(await totals(s2)).toEqual({
        checkouts: 1,
        orders: 1,
        units: 3,
        revenue: 2000,
      });
    });

    it('S40 AS-38: a reservation slot without a shop is counted as shop_missing and breaks nothing', async () => {
      const s1 = uuidv4();

      await t.deliver(live(), [reservedAt([s1, null])]);

      expect(await totals(s1)).toMatchObject({ checkouts: 1 });
      expect(t.metrics.live('shop_missing')).toBe(1);
    });

    it('S40 AS-39: seconds T-59 and T are in the frame of T, T-60 is not, T+2 is only in the frame of T+2, and a stale event changes nothing but still reaches the history', async () => {
      const shop = uuidv4();
      const sales = t.projector(SalesProjector);
      await t.deliver(live(), [
        paidAt(shop, -59, 10),
        paidAt(shop, 0, 20),
        paidAt(shop, -60, 40),
        paidAt(shop, 2, 80),
      ]);

      expect((await totals(shop, T)).revenue).toBe(10 + 20);
      expect((await totals(shop, T + 2)).revenue).toBe(20 + 80);
      expect((await t.counters().window(shop, T + 2)).at(-1)!.orders).toBe(1);

      const staleBefore = t.metrics.board('stale');
      const stale = paidAt(shop, -120, 999);
      await t.deliver(live(), [stale]);
      await t.deliver(sales, [stale]);

      expect(t.metrics.board('stale') - staleBefore).toBe(1);
      expect((await totals(shop, T)).revenue).toBe(30);
      expect(
        await t.sql(
          `SELECT sum(line_total_minor) AS n FROM shop_sale_facts WHERE shop_id = {id:String}`,
          { id: shop },
        ),
      ).toEqual([{ n: '999' }]);
    });
  });

  describe('AS-41: exactly once and crash-safe', () => {
    it('S40 AS-41: a redelivery, then ten at once, change no counter', async () => {
      const shop = uuidv4();
      const events = [
        ...Array.from({ length: 4 }, () => reservedAt([shop])),
        paidAt(shop, 0, 5000, 2),
      ];
      await t.deliver(live(), events);
      const once = await totals(shop);

      await t.deliver(live(), events);
      await Promise.all(
        Array.from({ length: 10 }, () => t.deliver(live(), events)),
      );

      expect(await totals(shop)).toEqual(once);
      expect(once).toEqual({
        checkouts: 4,
        orders: 1,
        units: 2,
        revenue: 5000,
      });
      expect(t.metrics.live('duplicate')).toBe(11 * 5);
    });

    it('S40 AS-41: a store failure on the first attempt leaves no mark, so the redelivery counts the event exactly once', async () => {
      const shop = uuidv4();
      const event = paidAt(shop, 0, 700);
      t.faults.redisFail = {
        match: (command, args) =>
          command === 'eval' && String(args[2]).includes(':seen:'),
        times: 1,
      };

      await expect(t.deliver(live(), [event])).rejects.toThrow();
      expect(await totals(shop)).toEqual({
        checkouts: 0,
        orders: 0,
        units: 0,
        revenue: 0,
      });

      await t.deliver(live(), [event]);
      await t.deliver(live(), [event]);

      expect(await totals(shop)).toEqual({
        checkouts: 0,
        orders: 1,
        units: 1,
        revenue: 700,
      });
    });
  });

  describe('AS-42..45: the ticker', () => {
    it('S40 AS-42: a watched shop gets one frame per second with strictly increasing seconds, empty ones included, decaying to zero when the sale leaves the window', async () => {
      const shop = await t.seedShop();
      await t.deliver(live(), [paidAt(shop.shopId, 0, 400)]);
      const [stream] = await watch(shop.owner, shop.shopId, 5);

      for (const second of [T, T + 1, T + 2, T + 59, T + 60])
        await t.ticker.tick(second);

      const received = frames(await stream);
      expect(received.map((f) => f.at)).toEqual([
        T,
        T + 1,
        T + 2,
        T + 59,
        T + 60,
      ]);
      expect(received.map((f) => f.last60s.orders)).toEqual([1, 1, 1, 1, 0]);
      expect(received.map((f) => f.last60s.revenueMinor)).toEqual([
        400, 400, 400, 400, 0,
      ]);
      expect(received.at(-1)!.checkoutConversion).toBeNull();
      expect(
        received.every(
          (f) => f.shopId === shop.shopId && f.windowSeconds === 60,
        ),
      ).toBe(true);
    });

    it('S40 AS-42: a shop nobody watches is not computed; a client that reconnects gets no earlier frame', async () => {
      const shop = await t.seedShop();
      await t.deliver(live(), [paidAt(shop.shopId, 0, 400)]);
      const before = t.metrics.frames();

      expect(await t.ticker.tick(T)).toBe(0);
      expect(t.metrics.frames()).toBe(before);

      const [first] = await watch(shop.owner, shop.shopId, 1);
      await t.ticker.tick(T + 1);
      expect(frames(await first).map((f) => f.at)).toEqual([T + 1]);
      await sleep(100);

      const [second] = await watch(shop.owner, shop.shopId, 1, 5000);
      await t.ticker.tick(T + 2);
      const reconnected = frames(await second);
      expect(reconnected.map((f) => f.at)).toEqual([T + 2]);
      expect(t.metrics.frames()).toBe(before + 2);
    });

    it('S40 AS-43: two ticker instances in the same second publish one frame; when the holder stops the other publishes within 5 seconds', async () => {
      const shop = await t.seedShop();
      const [a, b] = [t.extraTicker('instance-a'), t.extraTicker('instance-b')];
      const [stream] = await watch(shop.owner, shop.shopId, 2, 2500);

      const published = await Promise.all([a.tick(T), b.tick(T)]);

      expect(published.reduce((n, c) => n + c, 0)).toBe(1);
      expect(frames(await stream).map((f) => f.at)).toEqual([T]);
      const holder =
        (await t.redis.get(`live:{${shop.shopId}}:lease`)) === 'instance-a'
          ? a
          : b;
      const other = holder === a ? b : a;

      // a holder that dies without releasing: the lease runs out and the other instance takes over
      const [second] = await watch(shop.owner, shop.shopId, 1, 7000);
      const started = Date.now();
      let n = 1;
      while ((await other.tick(T + n++)) === 0) {
        expect(Date.now() - started).toBeLessThan(5000);
        await sleep(50);
      }
      expect(frames(await second)).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('S40 AS-44: a tick that overruns makes the next one skip, never overlap, and the next frame is right for its own second', async () => {
      const shop = await t.seedShop();
      await t.deliver(live(), [paidAt(shop.shopId, 0, 100)]);
      const [stream] = await watch(shop.owner, shop.shopId, 2, 6000);
      const original = t.counters().window.bind(t.counters());
      let running = 0;
      let overlapped = false;
      const spy = jest
        .spyOn(t.counters(), 'window')
        .mockImplementation(async (...args) => {
          running++;
          overlapped ||= running > 1;
          await sleep(400);
          try {
            return await original(...args);
          } finally {
            running--;
          }
        });
      const skipped = t.metrics.ticksSkipped();

      const slow = t.ticker.tick(T);
      const next = await t.ticker.tick(T + 1);
      const result = await slow;
      spy.mockRestore();
      const after = await t.ticker.tick(T + 2);

      expect(next).toBe(0);
      expect(result).toBe(1);
      expect(after).toBe(1);
      expect(overlapped).toBe(false);
      expect(t.metrics.ticksSkipped() - skipped).toBe(1);
      expect(frames(await stream).map((f) => [f.at, f.last60s.orders])).toEqual(
        [
          [T, 1],
          [T + 2, 1],
        ],
      );
    });

    it('S40 AS-45: each member receives only the frames of their own shop; a non-member is refused', async () => {
      const [s1, s2, outsider] = [
        await t.seedShop(),
        await t.seedShop(),
        await t.newUser(),
      ];
      await t.deliver(live(), [
        paidAt(s1.shopId, 0, 111),
        paidAt(s2.shopId, 0, 222),
      ]);
      const [[first], [second]] = [
        await watch(s1.owner, s1.shopId, 1),
        await watch(s2.owner, s2.shopId, 1),
      ];

      expect(await t.ticker.tick(T)).toBe(2);

      const [f1] = frames(await first);
      const [f2] = frames(await second);
      expect([f1.shopId, f1.last60s.revenueMinor]).toEqual([s1.shopId, 111]);
      expect([f2.shopId, f2.last60s.revenueMinor]).toEqual([s2.shopId, 222]);
      const refused = await t.subscribe(outsider, s1.shopId, {
        count: 1,
        timeoutMs: 2000,
      });
      expect(refused.status).toBe(403);
      const crossed = await t.subscribe(s2.owner, s1.shopId, {
        count: 1,
        timeoutMs: 2000,
      });
      expect(crossed.status).toBe(403);
    });
  });

  describe('AS-49: graceful shutdown', () => {
    it('S40 AS-49: a tick in progress finishes, nothing is published afterwards, the leases are released and another instance takes over at once', async () => {
      const shop = await t.seedShop();
      await t.deliver(live(), [paidAt(shop.shopId, 0, 100)]);
      const [a, b] = [t.extraTicker('instance-a'), t.extraTicker('instance-b')];
      const [stream] = await watch(shop.owner, shop.shopId, 3, 3000);
      const original = t.counters().window.bind(t.counters());
      const spy = jest
        .spyOn(t.counters(), 'window')
        .mockImplementation(async (...args) => {
          await sleep(300);
          return original(...args);
        });

      const running = a.tick(T);
      await sleep(100);
      await a.onApplicationShutdown();
      spy.mockRestore();

      expect(await running).toBe(1);
      expect(await a.tick(T + 1)).toBe(0);
      expect(await t.redis.exists(`live:{${shop.shopId}}:lease`)).toBe(0);
      expect(await b.tick(T + 2)).toBe(1);
      expect(frames(await stream).map((f) => f.at)).toEqual([T, T + 2]);
    });
  });
});
