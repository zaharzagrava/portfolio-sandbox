import {
  OrderCancelled,
  OrderFulfilmentChanged,
  OrderRefunded,
  OrderReserved,
} from '@app/domains/orders';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createTopics,
  deleteTopicsMatching,
  readTopic,
  testKafka,
} from '@app/test/utils/kafka-test';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  createRecommendationsApp,
  newId,
  paidEnvelope,
  type PaidOrder,
  type RecommendationsTestApp,
} from './testing/recommendations.fixtures';
import { RecommendationsProjectorModule } from './recommendations-projector.module';

const DAY = 86_400_000;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, M] = [1, 2, 3, 4].map(id);
const counter = (outcome: string) =>
  MetricsRegistry.value('recommendations_baskets_total', { outcome }) ?? 0;
const skipped = (reason: string) =>
  MetricsRegistry.value('recommendations_basket_skipped_total', { reason }) ??
  0;

describe('Order basket projection', () => {
  let t: RecommendationsTestApp;

  beforeAll(async () => {
    await deleteTopicsMatching(
      /^(orders\.events|discovery-order-baskets\.dlq)$/,
    );
    await createTopics([{ topic: 'orders.events' }]);
    t = await createRecommendationsApp({
      extraImports: [
        ProjectionsModule.forProjectors(
          RecommendationsProjectorModule.projectors,
          [RecommendationsProjectorModule],
        ),
      ],
    });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.clean();
  });

  const publish = async (
    values: (EventEnvelope | Buffer | string)[],
    key = newId(),
  ) => {
    const producer = testKafka().producer();
    await producer.connect();
    await producer.send({
      topic: 'orders.events',
      messages: values.map((v) => ({
        key,
        value:
          typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v),
      })),
    });
    await producer.disconnect();
  };

  describe('direct delivery to the consumer', () => {
    it('S34 AS-29: a paid order becomes one basket of distinct sorted products with the buyer, paidAt and version', async () => {
      const orderId = newId();
      const userId = newId();
      const paidAt = new Date(Date.now() - DAY);

      await t.deliverPaid({
        orderId,
        userId,
        productIds: [M, C, M],
        orderVersion: 3,
        paidAt,
      });

      expect(await t.baskets()).toEqual([
        {
          order_id: orderId,
          buyer_id: userId,
          products: [C, M],
          paid_at: expect.stringContaining(
            paidAt.toISOString().slice(0, 19).replace('T', ' '),
          ),
          order_version: 3,
        },
      ]);
    });

    it('S34 AS-30: the same message twice, also at once, leaves one basket and counts it as a duplicate', async () => {
      const order: PaidOrder = { orderId: newId(), productIds: [A, B] };
      const duplicates = counter('duplicate');

      await t.deliverPaid(order);
      await t.deliverPaid(order);
      await Promise.all([t.deliverPaid(order), t.deliverPaid(order)]);

      expect(await t.baskets()).toHaveLength(1);
      expect(counter('duplicate') - duplicates).toBeGreaterThanOrEqual(1);
    });

    it('S34 AS-33: orders below or above the size bounds are skipped and counted by reason, never failed', async () => {
      const ids = (n: number) =>
        Array.from({ length: n }, (_, i) => id(100 + i));
      const small = skipped('too_small');
      const large = skipped('too_large');

      await t.deliverPaid(
        { productIds: [A, A, A] },
        { productIds: ids(2) },
        { productIds: ids(30) },
        { productIds: ids(31) },
      );

      expect(
        (await t.baskets()).map((b) => b.products.length).sort((a, b) => a - b),
      ).toEqual([2, 30]);
      expect(skipped('too_small') - small).toBe(1);
      expect(skipped('too_large') - large).toBe(1);
    });

    it('S34 AS-34: orders arriving in reverse order are both stored and counted exactly once by the next build', async () => {
      const now = t.clock.now();
      const orders = [0, 1, 2].map((i) => ({
        productIds: [A, B],
        paidAt: new Date(now.getTime() - (3 - i) * DAY),
      }));

      for (const o of [...orders].reverse()) await t.deliverPaid(o);
      await t.deliverPaid(orders[1]); // redelivered
      expect(await t.baskets()).toHaveLength(3);
      expect(await t.listKeys()).toEqual([]);

      expect(await t.build()).toMatchObject({ outcome: 'completed', edges: 2 });
      expect(await t.storedList(A)).toEqual([[B, 1]]);
    });

    it('S34 AS-34: an order paid before the window is stored but never counted', async () => {
      const old = new Date(t.clock.now().getTime() - 200 * DAY);

      await t.deliverPaid(
        ...[1, 2, 3].map(() => ({ productIds: [A, B], paidAt: old })),
      );

      expect(await t.baskets()).toHaveLength(3);
      expect(await t.build()).toMatchObject({ outcome: 'skipped_empty' });
      expect(await t.listKeys()).toEqual([]);
    });

    it('S34 AS-34: a higher order version replaces the lines, a lower or equal one changes nothing', async () => {
      const orderId = newId();
      const stale = counter('stale');
      const stored = counter('stored');
      await t.deliverPaid({ orderId, productIds: [A, B], orderVersion: 2 });

      await t.deliverPaid({ orderId, productIds: [A, C], orderVersion: 1 });
      await t.deliverPaid({ orderId, productIds: [B, C], orderVersion: 2 });
      expect((await t.baskets())[0]).toMatchObject({
        products: [A, B],
        order_version: 2,
      });

      await t.deliverPaid({ orderId, productIds: [A, B, C], orderVersion: 4 });
      expect((await t.baskets())[0]).toMatchObject({
        products: [A, B, C],
        order_version: 4,
      });
      expect(counter('stale') - stale).toBe(1);
      expect(counter('stored') - stored).toBe(2);
    });

    it('S34 AS-35: replaying the history into an empty store rebuilds identical baskets and lists', async () => {
      const now = t.clock.now();
      const history: PaidOrder[] = [
        ...[1, 2, 3, 4].map((i) => ({
          orderId: id(1000 + i),
          productIds: [A, B, C],
          paidAt: new Date(now.getTime() - i * DAY),
        })),
        { orderId: id(1010), productIds: [A, C], orderVersion: 1, paidAt: now },
        { orderId: id(1010), productIds: [A, B], orderVersion: 2, paidAt: now },
        { orderId: id(1004), productIds: [A, B, C], paidAt: now }, // a redelivery
      ];
      await t.deliverPaid(...history);
      await t.build();
      const original = {
        baskets: await t.baskets(),
        lists: await Promise.all([A, B, C].map((p) => t.storedList(p))),
      };

      await t.clickhouse
        .getClient()
        .command({ query: 'TRUNCATE TABLE recommendation_baskets' });
      await t.redis.client.flushdb();
      expect(await t.baskets()).toEqual([]);
      await t.deliverPaid(...history);
      await t.build();

      expect(await t.baskets()).toEqual(original.baskets);
      expect(await Promise.all([A, B, C].map((p) => t.storedList(p)))).toEqual(
        original.lists,
      );
    });
  });

  describe('through the log and the consumer framework', () => {
    const stored = async () =>
      (await t.baskets()).map((b) => b.order_id).sort();
    const dead = async () => readTopic('discovery-order-baskets.dlq');

    it('S34 AS-31: invalid messages are dead-lettered with a reason, no basket is written, and the next valid message is processed', async () => {
      const first = newId();
      const last = newId();
      const base = paidEnvelope({ productIds: [A, B] });
      const withPayload = (
        mutate: (p: Record<string, unknown>) => void,
      ): EventEnvelope => {
        const copy = JSON.parse(JSON.stringify(base)) as EventEnvelope;
        mutate(copy.payload as Record<string, unknown>);
        return copy;
      };
      const lines = (base.payload as { lines: Record<string, unknown>[] })
        .lines;

      await publish([paidEnvelope({ orderId: first, productIds: [A, B] })]);
      await publish([
        withPayload((p) => delete p.orderId),
        withPayload((p) => {
          p.lines = [{ ...lines[0], productId: 'not-a-uuid' }, lines[1]];
        }),
        withPayload((p) => {
          p.lines = [];
        }),
        withPayload((p) => delete p.userId),
        { ...base, version: 99 },
        '{{{ not json',
      ]);
      await publish([paidEnvelope({ orderId: last, productIds: [A, C] })]);

      await waitFor(async () => (await stored()).length === 2, {
        description: 'both valid baskets stored',
      });
      await waitFor(async () => (await dead()).length === 6, {
        description: 'six dead letters',
        timeoutMs: 30_000,
      });
      expect(await stored()).toEqual([first, last].sort());
      for (const letter of await dead())
        expect(letter.headers['x-dlq-reason']).toBeTruthy();
    });

    it('S34 AS-32: order.reserved, cancelled, refunded and fulfilment_changed write no basket and no dead letter', async () => {
      const before = (await dead()).length;
      const orderId = newId();
      const base = { orderId, userId: newId(), orderVersion: 1 };
      const marker = newId();

      await publish([
        OrderReserved.create(orderId, 1, {
          ...base,
          totalMinor: 100,
          currency: 'USD',
          shopIds: [],
          reservedUntil: new Date().toISOString(),
        }),
        OrderCancelled.create(orderId, 2, {
          ...base,
          orderVersion: 2,
          reason: 'user_cancelled',
          previousStatus: 'PENDING',
        }),
        OrderRefunded.create(orderId, 3, {
          ...base,
          orderVersion: 3,
          amountMinor: 100,
          currency: 'USD',
          reason: 'x',
        }),
        OrderFulfilmentChanged.create(orderId, 4, {
          ...base,
          orderVersion: 4,
          status: 'SHIPPED',
        }),
        // a paid order behind them proves they were consumed, not stuck
        paidEnvelope({ orderId: marker, productIds: [A, B] }),
      ]);

      await waitFor(async () => (await stored()).includes(marker), {
        description: 'the marker basket stored',
      });
      expect(await stored()).toEqual([marker]);
      expect((await dead()).length).toBe(before);
    });
  });
});
