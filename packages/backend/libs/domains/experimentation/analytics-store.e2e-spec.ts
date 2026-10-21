import { v4 as uuidv4 } from 'uuid';
import { OrderPaid } from '@app/domains/orders';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { deadLetterTopic } from '@app/infrastructure/projections/dead-letter';
import { waitFor } from '@app/test/utils/async-helpers';
import { deleteTopicsMatching, readTopic } from '@app/test/utils/kafka-test';
import { AnalyticsProjectorModule } from './analytics-projector.module';
import { AnalyticsWorkerModule } from './analytics-worker.module';
import { StoreDeadLetterWatcher } from './application/store-dead-letter-watcher.service';
import { shardName } from '@app/common/shard';
import { ANALYTICS_TOPIC } from './domain/event-schema';
import { EVENT_STORE, type EventStore } from './domain/ports';
import { PurchaseEventsProjector } from './infra/purchase-events.projector';
import {
  T0,
  applyAnalyticsStore,
  chTime,
  createAnalyticsApp,
  dropAnalyticsStream,
  freshAnalyticsTopic,
  insertRows,
  storedRow,
  truncateAnalyticsStore,
  type AnalyticsTestApp,
  type StoredRow,
} from './testing/analytics.fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const metric = (name: string, labels: Record<string, string> = {}): number =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Analytics store, dedupe and purchase projector (S39)', () => {
  let t: AnalyticsTestApp;
  let store: EventStore;
  let projector: PurchaseEventsProjector;
  let watcher: StoreDeadLetterWatcher;

  beforeAll(async () => {
    await freshAnalyticsTopic();
    await deleteTopicsMatching(/^analytics-purchases\.dlq$/);
    t = await createAnalyticsApp({
      extraImports: [AnalyticsProjectorModule, AnalyticsWorkerModule],
    });
    await dropAnalyticsStream(t.clickhouse);
    await applyAnalyticsStore(t.clickhouse, { stream: true });
    store = t.app.get<EventStore>(EVENT_STORE);
    projector = t.app.get(PurchaseEventsProjector, { strict: false });
    watcher = t.app.get(StoreDeadLetterWatcher, { strict: false });
  });
  afterAll(async () => {
    await dropAnalyticsStream(t.clickhouse);
    await t.close();
    await deleteTopicsMatching(/^analytics-purchases\.dlq$/);
  });
  beforeEach(async () => {
    t.clock.set(T0);
    await truncateAnalyticsStore(t.clickhouse);
    await watcher.poll();
  });

  const rawRows = async (ids: string[]): Promise<number> => {
    const res = await t.clickhouse.getClient().query({
      query: `SELECT count() AS n FROM analytics_event_log WHERE event_id IN ({ids:Array(UUID)})`,
      query_params: { ids },
      format: 'JSONEachRow',
    });
    return Number((await res.json<{ n: string }>())[0].n);
  };

  describe('dedupe', () => {
    it('S39 AS-12: one event_id delivered three ways counts once and the first received copy is the one read, before and after a merge', async () => {
      const first = storedRow({
        name: 'page_view',
        ts: T0.getTime(),
        received_at: T0.getTime() + 1_000,
        props: { copy: 'first' },
      });
      // Another name, another receive time and a re-clamped ts that falls in another day's partition.
      const later = {
        ...first,
        name: 'click',
        ts: chTime(T0.getTime() + DAY),
        received_at: chTime(T0.getTime() + HOUR),
        props: { copy: 'later' },
      };
      await insertRows(t.clickhouse, [later, first, { ...first }]);
      const id = first.event_id;

      const before = await store.readEvents([id]);
      expect(before).toEqual([
        {
          event_id: id,
          name: 'page_view',
          anonymous_id: first.anonymous_id,
          user_id: '',
          ts: first.ts,
          props: { copy: 'first' },
        },
      ]);
      expect(await rawRows([id])).toBe(3);
      expect(await store.countEvents()).toBe(1);

      await t.clickhouse
        .getClient()
        .command({ query: 'OPTIMIZE TABLE analytics_event_log FINAL' });
      expect(await store.readEvents([id])).toEqual(before);
      expect(await rawRows([id])).toBe(3);
      expect(await store.countEvents()).toBe(1);
    });

    it('S39 AS-12: a client that retries a batch through the real pipeline leaves each event once in every read', async () => {
      const events = [t.event({ name: 'click' }), t.event({ name: 'search' })];
      expect((await t.postEvents({ events })).status).toBe(202);
      expect((await t.postEvents({ events })).status).toBe(202);
      const ids = events.map((e) => e.event_id);
      await waitFor(async () => (await rawRows(ids)) >= 4, {
        description: 'both deliveries stored',
      });
      const read = await store.readEvents(ids);
      expect(read.map((e) => e.event_id).sort()).toEqual([...ids].sort());
      expect(read).toHaveLength(2);
      expect(await rawRows(ids)).toBe(4);
      expect(await store.countEvents()).toBe(2);
    });

    it('S39 AS-12: replaying a 10,000-event set (other receive times, re-clamped ts, other names) leaves every count and result unchanged', async () => {
      const start = T0.getTime();
      const rows: StoredRow[] = [];
      // 2,000 users: a first exposure each (half control, half treatment), a purchase for every 4th, and page views.
      for (let u = 0; u < 2_000; u++) {
        const user_id = `replay-user-${u}`;
        rows.push(
          storedRow({
            name: 'exposure',
            user_id,
            anonymous_id: `anon-replay-${u}-xxxxxxxx`,
            ts: start + u,
            props: {
              experiment: 'replay',
              variant: u % 2 ? 'treatment' : 'control',
            },
          }),
        );
        if (u % 4 === 0)
          rows.push(
            storedRow({
              name: 'purchase',
              user_id,
              anonymous_id: '',
              ts: start + HOUR + u,
            }),
          );
        for (let p = 0; p < 3; p++)
          rows.push(
            storedRow({
              name: 'page_view',
              user_id,
              anonymous_id: `anon-replay-${u}-xxxxxxxx`,
              ts: start + 2 * HOUR + p,
            }),
          );
      }
      rows.length = Math.min(rows.length, 10_000);
      const query = {
        experimentKey: 'replay',
        metric: 'purchase',
        unit: 'user' as const,
        variants: ['control', 'treatment'],
        windowStart: new Date(start - HOUR),
        windowEnd: new Date(start + 6 * HOUR),
      };
      await insertRows(t.clickhouse, rows);
      const events = await store.countEvents();
      const results = await store.readResults(query);
      expect(events).toBe(rows.length);
      expect(
        results.variants.reduce((n, v) => n + v.exposures, 0),
      ).toBeGreaterThan(1_000);

      // The same set again: later receive time, one in five with a re-clamped ts, one in seven with another name.
      await insertRows(
        t.clickhouse,
        rows.map((row, i) => ({
          ...row,
          received_at: chTime(start + 3 * HOUR + i),
          ...(i % 5 === 0 ? { ts: chTime(start + 2 * DAY) } : {}),
          ...(i % 7 === 0 ? { name: 'click' } : {}),
        })),
      );
      expect(await store.countEvents()).toBe(events);
      expect(await store.readResults(query)).toEqual(results);
    }, 120_000);
  });

  describe('ordering', () => {
    const query = (variants = ['control', 'free']) => ({
      experimentKey: 'ordering',
      metric: 'purchase',
      unit: 'user' as const,
      variants,
      windowStart: new Date(T0.getTime() - HOUR),
      windowEnd: new Date(T0.getTime() + 2 * HOUR),
    });
    const exposure = (user_id: string, ts: number) =>
      storedRow({
        name: 'exposure',
        user_id,
        ts,
        received_at: ts,
        props: { experiment: 'ordering', variant: 'control' },
      });
    const purchase = (user_id: string, ts: number, received: number) =>
      storedRow({
        name: 'purchase',
        user_id,
        anonymous_id: '',
        platform: 'server',
        ts,
        received_at: received,
      });

    it('S39 AS-13: a purchase 5 minutes after the exposure converts even when it arrived first; one 5 minutes before never does', async () => {
      const after = `after-${uuidv4()}`;
      const before = `before-${uuidv4()}`;
      const T = T0.getTime();
      await insertRows(t.clickhouse, [
        // arrival order: both purchases first, exposures second
        purchase(after, T + 5 * MIN, T + 10 * MIN),
        purchase(before, T - 5 * MIN, T + 11 * MIN),
        exposure(after, T),
        exposure(before, T),
      ]);
      const result = await store.readResults(query());
      expect(result.variants.find((v) => v.variant === 'control')).toEqual({
        variant: 'control',
        exposures: 2,
        conversions: 1,
      });
    });
  });

  describe('dead letters', () => {
    const valid = (patch: Record<string, unknown> = {}) => ({
      event_id: uuidv4(),
      name: 'page_view',
      anonymous_id: 'anon-store-12345678',
      user_id: '',
      ts: chTime(T0),
      received_at: chTime(T0),
      country: '',
      platform: 'web',
      page: '',
      props: {},
      ...patch,
    });
    const errorRows = async () =>
      (
        await t.clickhouse.getClient().query({
          query:
            'SELECT raw, error, topic, partition, offset, at FROM analytics_events_errors',
          format: 'JSONEachRow',
        })
      ).json<{
        raw: string;
        error: string;
        topic: string;
        partition: string;
        offset: string;
        at: string;
      }>();

    it('S39 AS-14: a message that is not JSON between good ones lands in the error table, the stream keeps going, and the dead letter is counted', async () => {
      const a = valid();
      const b = valid();
      const garbage = '{ this is not json';
      const deadLetters = metric('analytics_dead_letter_total', {
        source: 'store',
      });
      await t.producer.sendMany(ANALYTICS_TOPIC, [
        { key: 'k', value: JSON.stringify(a) },
        { key: 'k', value: garbage },
        { key: 'k', value: JSON.stringify(b) },
      ]);
      await waitFor(
        async () => (await rawRows([a.event_id, b.event_id])) === 2,
        {
          description: 'both good events stored',
          timeoutMs: 30_000,
        },
      );
      const [row, ...others] = await waitFor(
        async () => {
          const rows = await errorRows();
          return rows.length ? rows : null;
        },
        { description: 'error row', timeoutMs: 30_000 },
      );
      expect(others).toHaveLength(0);
      expect(row.raw).toBe(garbage);
      expect(row.error.length).toBeGreaterThan(0);
      expect(row.topic).toBe(shardName(ANALYTICS_TOPIC));
      expect(Number(row.partition)).toBeGreaterThanOrEqual(0);
      expect(Number(row.offset)).toBeGreaterThanOrEqual(0);
      expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

      // The stream is still being consumed after the bad message.
      const c = valid();
      await t.producer.sendMany(ANALYTICS_TOPIC, [
        { key: 'k', value: JSON.stringify(c) },
      ]);
      await waitFor(async () => (await rawRows([c.event_id])) === 1, {
        description: 'event after the bad message stored',
        timeoutMs: 30_000,
      });

      expect(await watcher.poll()).toBe(1);
      expect(metric('analytics_dead_letter_total', { source: 'store' })).toBe(
        deadLetters + 1,
      );
      expect(await watcher.poll()).toBe(0);
    }, 120_000);

    it('S39 AS-14: a message with a field of the wrong type is a dead letter too', async () => {
      const bad = JSON.stringify(valid({ event_id: 12345 }));
      const good = valid();
      await t.producer.sendMany(ANALYTICS_TOPIC, [
        { key: 'k', value: bad },
        { key: 'k', value: JSON.stringify(good) },
      ]);
      await waitFor(async () => (await rawRows([good.event_id])) === 1, {
        description: 'good event stored',
        timeoutMs: 30_000,
      });
      const rows = await waitFor(
        async () => {
          const found = await errorRows();
          return found.length ? found : null;
        },
        { description: 'error row', timeoutMs: 30_000 },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].raw).toBe(bad);
      expect(await watcher.poll()).toBe(1);
    }, 120_000);
  });

  describe('purchase projector', () => {
    const paid = (
      userId: string,
      occurredAt = T0,
      patch: Record<string, unknown> = {},
    ) =>
      OrderPaid.create(
        uuidv4(),
        3,
        {
          orderId: uuidv4(),
          userId,
          orderVersion: 3,
          totalMinor: 4999,
          currency: 'usd',
          paymentRef: 'pay_1',
          paidAt: occurredAt.toISOString(),
          lines: [],
          shopOrders: [],
          ...patch,
        } as never,
        occurredAt,
      );

    it('S39 AS-15: one order.paid becomes one purchase event with the envelope id, event time and props; a second delivery adds nothing to any read', async () => {
      const userId = `buyer-${uuidv4()}`;
      const envelope = paid(userId, new Date(T0.getTime() - 3 * MIN));
      await projector.project([envelope]);
      const [purchase] = await store.readEvents([envelope.eventId]);
      expect(purchase).toEqual({
        event_id: envelope.eventId,
        name: 'purchase',
        anonymous_id: '',
        user_id: userId,
        ts: chTime(T0.getTime() - 3 * MIN),
        props: {
          order_id: envelope.aggregateId,
          total: '4999',
          currency: 'usd',
        },
      });
      const platform = await t.clickhouse.getClient().query({
        query: `SELECT platform, received_at FROM analytics_event_log WHERE event_id = {id:UUID}`,
        query_params: { id: envelope.eventId },
        format: 'JSONEachRow',
      });
      expect(await platform.json()).toEqual([
        { platform: 'server', received_at: chTime(T0) },
      ]);

      await projector.project([envelope]);
      expect(await store.readEvents([envelope.eventId])).toEqual([purchase]);
      expect(await store.countEvents()).toBe(1);
    });

    it('S39 AS-15: a payload that fails the order.paid schema stores nothing and is dead-lettered and counted', async () => {
      const good = paid(`buyer-${uuidv4()}`);
      // `create` refuses a bad payload, so the broken envelope is a valid one with its payload damaged afterwards.
      const template = paid('x');
      const broken = {
        ...template,
        payload: { ...template.payload, totalMinor: 'a lot' },
      };
      const before = metric('analytics_dead_letter_total', {
        source: 'purchase-projector',
      });
      await projector.project([broken, good]);

      expect(await store.readEvents([broken.eventId])).toEqual([]);
      expect(await store.readEvents([good.eventId])).toHaveLength(1);
      const letters = await readTopic(deadLetterTopic('analytics-purchases'));
      expect(letters).toHaveLength(1);
      expect(letters[0].headers).toMatchObject({
        'x-consumer': 'analytics-purchases',
        'x-dlq-reason-code': 'INVALID_PAYLOAD',
        'x-source-topic': OrderPaid.topic,
      });
      expect(letters[0].headers['x-dlq-reason']).toContain('totalMinor');
      expect(letters[0].headers['x-dlq-reason']).not.toContain('a lot');
      expect(letters[0].json<{ eventId: string }>().eventId).toBe(
        broken.eventId,
      );
      expect(
        metric('analytics_dead_letter_total', { source: 'purchase-projector' }),
      ).toBe(before + 1);
    });
  });

  describe('definition', () => {
    it('S39 AS-16: events are partitioned by event day and kept 400 days, errors 14 days, and the consumer group is clickhouse-analytics', async () => {
      const show = async (table: string) =>
        (
          await (
            await t.clickhouse.getClient().query({
              query: `SELECT engine, partition_key, sorting_key, create_table_query FROM system.tables WHERE database = currentDatabase() AND name = {table:String}`,
              query_params: { table },
              format: 'JSONEachRow',
            })
          ).json<Record<string, string>>()
        )[0];
      const log = await show('analytics_event_log');
      expect(log.engine).toBe('MergeTree');
      expect(log.partition_key).toBe('toYYYYMMDD(ts)');
      expect(log.sorting_key).toBe('toDate(ts), name, event_id');
      expect(log.create_table_query).toMatch(
        /TTL toDateTime\(ts\) \+ toIntervalDay\(400\)/,
      );
      const errors = await show('analytics_events_errors');
      expect(errors.create_table_query).toMatch(
        /TTL at \+ toIntervalDay\(14\)/,
      );
      const queue = await show('analytics_events_queue');
      expect(queue.engine).toBe('Kafka');
      expect(queue.create_table_query).toContain(
        `kafka_group_name = '${shardName('clickhouse-analytics')}'`,
      );
      expect(queue.create_table_query).toContain(
        `kafka_topic_list = '${shardName('analytics.events')}'`,
      );
      expect(queue.create_table_query).toContain(
        "kafka_handle_error_mode = 'stream'",
      );
    });
  });
});
