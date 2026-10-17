import { v4 as uuidv4 } from 'uuid';
import { BoardProjector } from './infra/projectors/board.projector';
import { LiveProjector } from './infra/projectors/live.projector';
import { SalesProjector } from './infra/projectors/sales.projector';
import { insightsMetrics } from './application/seller-insights.metrics';
import {
  createInsightsApp,
  T0,
  type InsightsTestApp,
} from './testing/insights-fixtures';

describe('Seller insights: metrics and logs', () => {
  let t: InsightsTestApp;

  beforeAll(async () => {
    t = await createInsightsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const boards = () => t.projector(BoardProjector);

  it('S40 AS-61: each outcome counter holds exactly the increments the replayed scenarios state, and every log line is structured with a correlation id and no buyer or payload data', async () => {
    const shop = await t.seedShop({ name: 'Alpha' });
    const p1 = await t.product(shop.shopId, 'electronics');
    const buyer = 'buyer-sensitive-42';
    const order = (paidAt: Date | string, productId: string, total: number) =>
      t.paid({
        paidAt,
        userId: buyer,
        lines: [{ shopId: shop.shopId, productId, lineTotalMinor: total }],
      });

    // AS-01: one order, two periods
    const o1 = order(T0, p1, 5000);
    await t.deliver(boards(), [o1]);
    // AS-02: thirteen redeliveries of two periods
    await t.deliver(boards(), [o1]);
    await Promise.all([t.deliver(boards(), [o1]), t.deliver(boards(), [o1])]);
    await Promise.all(
      Array.from({ length: 10 }, () => t.deliver(boards(), [o1])),
    );
    // AS-09: a frozen week and a late order
    await t.deliver(boards(), [order('2026-10-04T09:00:00Z', p1, 10_000)]);
    t.clock.set(new Date('2026-10-05T01:00:00Z'));
    await t.freeze('2026-W40');
    t.clock.set(T0);
    await t.deliver(boards(), [order('2026-10-04T10:00:00Z', p1, 500)]);
    // AS-10: six messages the consumer rejects, one it never sees (envelope version), one valid
    const body = (over: Record<string, unknown>) => ({
      orderId: uuidv4(),
      userId: buyer,
      orderVersion: 2,
      totalMinor: 100,
      currency: 'EUR',
      paymentRef: 'pay',
      paidAt: T0.toISOString(),
      lines: [
        {
          productId: p1,
          shopId: shop.shopId,
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
    const { orderId: _gone, ...withoutId } = body({});
    const bad = [
      t.raw('order.paid', 'orders', uuidv4(), withoutId),
      t.raw('order.paid', 'orders', uuidv4(), body({ paidAt: 'yesterday' })),
      t.raw('order.paid', 'orders', uuidv4(), body({ lines: [] })),
      t.raw('order.paid', 'orders', uuidv4(), body({ currency: 'USD' })),
      t.raw(
        'order.paid',
        'orders',
        uuidv4(),
        body({
          lines: [
            {
              productId: p1,
              shopId: 'nope',
              title: 'x',
              quantity: 1,
              lineTotalMinor: 5,
            },
          ],
        }),
      ),
      t.raw(
        'order.paid',
        'orders',
        uuidv4(),
        body({
          lines: [
            {
              productId: p1,
              shopId: shop.shopId,
              title: 'x',
              quantity: 1,
              lineTotalMinor: -5,
            },
          ],
        }),
      ),
      t.raw('order.paid', 'orders', uuidv4(), body({}), { version: 2 }),
    ];
    await t.deliver(boards(), [...bad, order(T0, p1, 250)]);
    // AS-11: a product with no category
    await t.deliver(boards(), [order(T0, uuidv4(), 3000)]);
    // AS-39: a stale live event
    await t.deliver(t.projector(LiveProjector), [
      order(new Date(T0.getTime() - 120_000), p1, 900),
    ]);

    expect({
      applied: t.metrics.board('applied'),
      duplicate: t.metrics.board('duplicate'),
      sealed: t.metrics.board('sealed'),
      rejected: t.metrics.board('rejected'),
      category_unresolved: t.metrics.board('category_unresolved'),
      stale: t.metrics.board('stale'),
    }).toEqual({
      applied: 2 + 2 + 1 + 2 + 2,
      duplicate: 26,
      sealed: 1,
      rejected: 6,
      category_unresolved: 1,
      stale: 1,
    });
    expect(t.metrics.deadLetter('boards', 'invalid_payload')).toBe(5);
    expect(t.metrics.deadLetter('boards', 'unsupported_currency')).toBe(1);

    // every line of the feeds is one JSON object with a correlation id, and tells nothing about the buyer or the payload
    const lines = t.logs();
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const { line } of lines) {
      expect(typeof line.event).toBe('string');
      expect(line.traceId ?? line.requestId).toBeTruthy();
    }
    const text = JSON.stringify(lines);
    expect(text).not.toContain(buyer);
    expect(text).not.toMatch(
      /@example\.com|lineTotalMinor|paymentRef|"userId"/,
    );
    expect(
      lines.filter((l) => l.line.event === 'message_dead_lettered'),
    ).toHaveLength(6);
  });

  it('S40 AS-61: the oldest-unprocessed-event age of a feed is a gauge: it shows the age while a batch is stuck and drops to zero once it is processed', async () => {
    const a = await t.readModelShop('Alpha');
    const old = t.paid({
      paidAt: T0,
      lines: [{ shopId: a.shopId, productId: uuidv4(), lineTotalMinor: 100 }],
    });
    const aged = {
      ...old,
      occurredAt: new Date(T0.getTime() - 45_000).toISOString(),
    };
    t.faults.redisFail = { match: (command) => command === 'eval', times: 1 };

    await expect(t.deliver(boards(), [aged])).rejects.toThrow();
    expect(insightsMetrics.value.lag('boards')).toBe(45);

    await t.deliver(boards(), [aged]);
    expect(insightsMetrics.value.lag('boards')).toBe(0);
    await t.deliver(t.projector(LiveProjector), [aged]);
    await t.deliver(t.projector(SalesProjector), [aged]);
    expect(insightsMetrics.value.lag('live')).toBe(0);
    expect(insightsMetrics.value.lag('sales')).toBe(0);
  });

  it('S40 AS-61: a ticker failure is one structured line with a correlation id and the shop, nothing else', async () => {
    const shop = await t.seedShop();
    const stream = t.subscribe(shop.owner, shop.shopId, {
      count: 1,
      timeoutMs: 1500,
    });
    await t.waitForSubscriber(shop.shopId);
    t.faults.redisFail = {
      match: (command) => command === 'pipeline',
      times: 1,
    };

    const published = await t.ticker.tick(Math.floor(T0.getTime() / 1000));
    await stream;

    expect(published).toBe(0);
    const failed = t
      .logs()
      .filter((l) => l.line.event === 'dashboard_frame_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].line).toMatchObject({ shopId: shop.shopId });
    expect(failed[0].line.traceId).toBeTruthy();
  });
});
