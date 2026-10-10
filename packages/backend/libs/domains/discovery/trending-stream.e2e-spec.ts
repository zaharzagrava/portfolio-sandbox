import { randomUUID } from 'node:crypto';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { deleteTopicsMatching, readTopic } from '@app/test/utils/kafka-test';
import { RedisTrendingAggregateAdapter } from './infra/redis-trending-aggregate.adapter';
import { aggregateKey, mergeKey, seenKey } from './infra/trending-keys';
import {
  createProjectorOnly,
  createTrendingApp,
  DAY,
  sleep,
  storedEvent,
  waitFor,
  windowOf,
  type TrendingAppOptions,
  type TrendingTestApp,
} from './testing/trending.fixtures';

const events = (outcome: string) =>
  MetricsRegistry.value('trending_events_total', { outcome }) ?? 0;
const merges = (outcome: string) =>
  MetricsRegistry.value('trending_merges_total', { outcome }) ?? 0;
const views = (
  productId: string,
  time: string,
  n: number,
  category = 'audio',
) =>
  Array.from({ length: n }, () =>
    storedEvent({ productId, category, at: time }),
  );
/** One event far enough ahead to close every window before it (watermark = event time - 2 min). */
const closer = (time = '12:30:00') =>
  storedEvent({ productId: randomUUID(), category: 'audio', at: time });
const ws = windowOf;

describe('Trending streaming aggregation', () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  const boot = async (options: TrendingAppOptions = {}) => {
    const t = await createTrendingApp(options);
    apps.push(t);
    await t.clean();
    return t;
  };

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close().catch(() => undefined);
  });
  afterAll(() => deleteTopicsMatching(/^analytics\.events\.s35\./));

  describe('delivery', () => {
    it('S35 AS-29: the same event delivered three times in one batch, in different batches and after a restart counts once', async () => {
      const t = await boot();
      const A = randomUUID();
      const e = storedEvent({
        productId: A,
        category: 'audio',
        at: '12:00:30',
      });
      const before = events('duplicate');
      await t.produce([e, e, e]);
      await t.settle();
      await t.produce([e]); // a different batch of the same open window
      await t.settle();
      expect(events('duplicate') - before).toBe(3);

      // restart: the first consumer dies unmerged and uncommitted; the next one replays the log, copies included
      await t.consumer.abandon();
      const second = await createProjectorOnly({
        topic: t.topic,
        groupId: t.groupId,
        clock: t.clock,
      });
      apps.push(second);
      await second.consumer.whenReady();
      await t.produce([e, closer()]);
      await waitFor(
        async () => (await t.aggregate('all', ws('12:00'))).length > 0,
        {
          description: 'merged after restart',
        },
      );
      expect(await t.aggregate('all', ws('12:00'))).toEqual([[A, 1]]);
      expect(await t.aggregate('audio', ws('12:00'))).toEqual([[A, 1]]);
    });

    it('S35 AS-30: invalid payloads are dead-lettered with a reason, change nothing but the invalid counter, and never block the partition', async () => {
      const t = await boot();
      const A = randomUUID();
      const good = storedEvent({
        productId: A,
        category: 'audio',
        at: '12:00:30',
      });
      const noId = {
        ...storedEvent({ productId: A, at: '12:00:31' }),
      } as Record<string, unknown>;
      delete noId.event_id;
      const bad = [
        'this is not json',
        noId,
        storedEvent({ name: 'teleport', productId: A, at: '12:00:32' }),
        storedEvent({ productId: A, at: '12:00:33', visitor: 'short' }),
        storedEvent({
          productId: A,
          at: '12:00:34',
          ts: '2026-10-10T12:00:34Z',
        }),
        storedEvent({
          productId: A,
          at: '12:00:35',
          ts: `${DAY} 12:61:00.000`,
        }),
        storedEvent({ productId: 'not-a-uuid', at: '12:00:36' }),
      ];
      const invalidBefore = events('invalid');
      const countedBefore = events('counted');
      await t.produce([bad[0], good, ...bad.slice(1), closer()]);
      await t.settle();

      // the valid message in the same batch was processed; nothing of the bad ones is in the aggregate
      expect(await t.aggregate('all', ws('12:00'))).toEqual([[A, 1]]);
      expect(events('invalid') - invalidBefore).toBe(bad.length);
      expect(events('counted') - countedBefore).toBe(2); // good + closer

      const letters = (await readTopic('discovery-trending-topk.dlq')).filter(
        (m) => m.headers['x-source-topic'] === t.topic,
      );
      expect(letters).toHaveLength(bad.length);
      for (const letter of letters) {
        expect(letter.headers['x-dlq-reason-code']).toBe('INVALID_PAYLOAD');
        expect(letter.headers['x-dlq-reason']).not.toBe('');
        expect(letter.headers['x-consumer']).toBe('discovery-trending-topk');
      }
      // the reason names schema paths, never a value of the payload
      const reasons = letters.map((l) => l.headers['x-dlq-reason']).join('\n');
      expect(reasons).toContain('event_id');
      expect(reasons).not.toContain('short');
      expect(reasons).not.toContain(A);
    });

    it('S35 AS-16: other event names and product events without a product id change nothing and are counted as ignored', async () => {
      const t = await boot();
      const ignoredBefore = events('ignored');
      await t.produce([
        ...['page_view', 'search', 'checkout_step', 'exposure', 'click'].map(
          (name) =>
            storedEvent({ name, productId: randomUUID(), at: '12:00:30' }),
        ),
        storedEvent({ productId: null, at: '12:00:31' }),
        storedEvent({ name: 'add_to_cart', productId: null, at: '12:00:32' }),
        closer(),
      ]);
      await t.settle();
      expect(events('ignored') - ignoredBefore).toBe(7);
      expect(await t.aggregate('all', ws('12:00'))).toEqual([]);
    });

    it('S35 AS-22: one visitor moves a product by one view and one add-to-cart per window; two visitors add two', async () => {
      const t = await boot();
      const A = randomUUID();
      const capped = events('visitor_capped');
      const flood = Array.from({ length: 50 }, () =>
        storedEvent({
          productId: A,
          at: '12:00:10',
          visitor: 'visitor-flooder',
        }),
      );
      await t.produce([
        ...flood,
        storedEvent({
          name: 'add_to_cart',
          productId: A,
          at: '12:00:20',
          visitor: 'visitor-flooder',
        }),
        storedEvent({
          productId: A,
          at: '12:00:30',
          visitor: 'visitor-other-1',
        }),
        storedEvent({
          productId: A,
          at: '12:01:10',
          visitor: 'visitor-flooder',
        }), // next window
        closer(),
      ]);
      await t.settle();
      expect(await t.aggregate('all', ws('12:00'))).toEqual([[A, 1 + 5 + 1]]);
      expect(await t.aggregate('all', ws('12:01'))).toEqual([[A, 1]]);
      expect(events('visitor_capped') - capped).toBe(49);
    });
  });

  describe('merge across partitions and bounds', () => {
    it('S35 AS-26: partition-level top-K lists are summed into one aggregate and a product in one partition is not lost', async () => {
      const t = await boot({ partitions: 2 });
      const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()];
      await t.produce(
        [...views(A, '12:00:10', 30), ...views(B, '12:00:20', 20), closer()],
        { partition: 0 },
      );
      await t.produce(
        [...views(B, '12:00:30', 15), ...views(C, '12:00:40', 3), closer()],
        { partition: 1 },
      );
      await t.settle();
      expect(await t.aggregate('all', ws('12:00'))).toEqual([
        [B, 35],
        [A, 30],
        [C, 3],
      ]);
      expect(await t.aggregate('audio', ws('12:00'))).toEqual([
        [B, 35],
        [A, 30],
        [C, 3],
      ]);
      // one merge record per partition and window
      expect(await t.keys('trending:merge:*')).toEqual(
        expect.arrayContaining([
          mergeKey(0, ws('12:00')),
          mergeKey(1, ws('12:00')),
        ]),
      );
    });

    it('S35 AS-26: a partition with more than K distinct products merges only its K heaviest', async () => {
      const t = await boot({ env: { TRENDING_HEAP_K: '40' } });
      const heavy = randomUUID();
      const light = Array.from({ length: 60 }, () => randomUUID());
      await t.produce([
        ...light.flatMap((id) => views(id, '12:00:10', 1)),
        ...views(heavy, '12:00:20', 5),
        closer(),
      ]);
      await t.settle();
      const stored = await t.aggregate('all', ws('12:00'));
      expect(stored).toHaveLength(40);
      expect(stored[0]).toEqual([heavy, 5]);
    });

    it('S35 AS-27: at most 100 categories are tracked per partition-window, the rest count in all only; invalid categories count in all and are rejected', async () => {
      // 10,001 distinct events in one window need a filter sized for them, or false "seen" would hide some
      const t = await boot({ env: { TRENDING_FILTER_BITS: '4194304' } });
      const capped = events('category_capped');
      const rejected = events('category_rejected');
      const batch: ReturnType<typeof storedEvent>[] = [];
      for (let c = 0; c < 1_000; c++)
        for (let p = 0; p < 10; p++)
          batch.push(
            storedEvent({
              productId: randomUUID(),
              category: `cat-${String(c).padStart(4, '0')}`,
              at: '12:00:10',
            }),
          );
      batch.push(
        storedEvent({
          productId: randomUUID(),
          category: 'Bad Cat',
          at: '12:00:11',
        }),
      );
      for (let i = 0; i < batch.length; i += 2_000)
        await t.produce(batch.slice(i, i + 2_000));
      await t.produce([closer()]);
      await t.settle();

      const categoryKeys = (await t.keys(`trending:{cat-*}:${ws('12:00')}`))
        .length;
      expect(categoryKeys).toBe(100);
      expect(events('category_capped') - capped).toBe(9_000);
      expect(events('category_rejected') - rejected).toBe(1);
      // all counts every event (capped at K entries by the heap): the first 100 categories kept counting normally
      expect((await t.aggregate('all', ws('12:00'))).length).toBeGreaterThan(0);
      expect(await t.keys(`trending:{Bad Cat}:*`)).toEqual([]);
      const bytes = MetricsRegistry.value('trending_tracked_bytes') ?? 0;
      expect(bytes).toBeLessThan(512 * 1024 * 1024);
    });
  });

  describe('event time', () => {
    it('S35 AS-19: late events count in their window, take the correction path inside the horizon once, and are dropped beyond it', async () => {
      const t = await boot();
      t.clock.set(new Date(`${DAY}T12:12:00Z`));
      const [X, Y, P1, P2, P3] = [1, 2, 3, 4, 5].map(() => randomUUID());
      await t.produce([...views(X, '12:05:10', 1), ...views(Y, '12:11:59', 1)]);
      await t.settle();
      // watermark 12:09:59: [12:05] merged, [12:11] open
      expect(await t.aggregate('all', ws('12:05'))).toEqual([[X, 1]]);

      const corrected = events('late_corrected');
      const dropped = events('late_dropped');
      const lateOnce = storedEvent({
        productId: P2,
        category: 'audio',
        at: '12:05:30',
      });
      await t.produce([
        ...views(P1, '12:09:30', 1), // inside the lateness: its window is still open
        lateOnce,
        lateOnce, // redelivered
        ...views(P3, '10:50:00', 1), // outside the last 60 minutes
      ]);
      await t.settle();

      expect(events('late_dropped') - dropped).toBe(1);
      expect(events('late_corrected') - corrected).toBe(2);
      expect(await t.aggregate('all', ws('12:05'))).toEqual(
        expect.arrayContaining([
          [X, 1],
          [P2, 1],
        ]),
      );
      expect(await t.aggregate('audio', ws('12:05'))).toEqual(
        expect.arrayContaining([[P2, 1]]),
      );
      expect(await t.aggregate('all', ws('12:09'))).toEqual([]); // not closed yet
      expect(await t.ttl(seenKey(lateOnce.event_id))).toBeGreaterThan(0);
      expect(await t.ttl(seenKey(lateOnce.event_id))).toBeLessThanOrEqual(
        10_800,
      );

      await t.produce([closer('12:20:00')]);
      await t.settle();
      expect(await t.aggregate('all', ws('12:09'))).toEqual([[P1, 1]]);
      expect(await t.aggregate('all', ws('12:11'))).toEqual([[Y, 1]]);
      for (const start of ['10:50', '12:05', '12:09', '12:11'])
        expect(
          (await t.aggregate('all', ws(start))).find(([m]) => m === P3),
        ).toBeUndefined();
    });

    it('S35 AS-20: a forged future ts does not close any window and later legitimate events are not late', async () => {
      const t = await boot();
      const [A, B] = [randomUUID(), randomUUID()];
      const late = events('late_corrected') + events('late_dropped');
      await t.produce([
        ...views(A, '12:00:30', 1),
        // ts claims 13:30, the broker received it at 12:00:35
        storedEvent({
          productId: B,
          category: 'audio',
          at: '12:00:35',
          ts: `${DAY} 13:30:00.000`,
          receivedAt: '12:00:35',
        }),
        ...views(B, '12:00:40', 1, 'audio'),
      ]);
      await t.settle();
      expect(await t.aggregate('all', ws('12:00'))).toEqual([]); // nothing closed early
      expect(await t.aggregate('all', ws('13:30'))).toEqual([]);
      expect(events('late_corrected') + events('late_dropped')).toBe(late);
    });

    it('S35 AS-21: a quiet partition closes by the wall clock, a busy one is not advanced', async () => {
      const t = await boot({ partitions: 2 });
      t.clock.set(new Date(`${DAY}T12:00:20Z`));
      const [quiet, busy] = [randomUUID(), randomUUID()];
      await t.produce(
        [
          storedEvent({
            productId: quiet,
            category: 'audio',
            at: '12:00:15',
            receivedAt: '12:00:15',
          }),
        ],
        { partition: 0 },
      );
      await t.produce(
        [storedEvent({ productId: busy, category: 'audio', at: '12:00:30' })],
        { partition: 1 },
      );
      await t.settle();
      t.clock.set(new Date(`${DAY}T12:03:10Z`));
      await t.produce(
        [storedEvent({ productId: busy, category: 'audio', at: '12:00:40' })],
        { partition: 1 },
      );
      await t.settle();
      expect(await t.aggregate('all', ws('12:00'))).toEqual([]);

      t.clock.set(new Date(`${DAY}T12:03:20Z`));
      await t.consumer.tickNow();
      // no later event ever arrived on partition 0, yet its window is visible now
      expect(await t.aggregate('all', ws('12:00'))).toEqual([[quiet, 1]]);
    });
  });

  describe('crash, restart and ownership', () => {
    it('S35 AS-31: a merge replayed after a crash before the commit changes nothing', async () => {
      const t = await boot();
      // the consumer merges but never gets to commit: "killed between the merge and the commit"
      (
        t.consumer as unknown as { consumer: { commitOffsets: unknown } }
      ).consumer.commitOffsets = async () => {
        throw new Error('killed before commit');
      };
      const B = randomUUID();
      await t.produce([
        ...views(B, '12:00:10', 20),
        ...views(B, '12:00:20', 15),
        closer(),
      ]);
      await t.settle();
      expect(await t.aggregate('all', ws('12:00'))).toEqual([[B, 35]]);
      expect(await t.committed()).toEqual({});
      await t.consumer.abandon();

      const replayed = merges('merge_replayed');
      const second = await createProjectorOnly({
        topic: t.topic,
        groupId: t.groupId,
        clock: t.clock,
      });
      apps.push(second);
      await second.consumer.whenReady();
      await waitFor(
        async () => (second.ingest.positions().get(0) ?? -1) >= 35,
        {
          description: 'replayed',
        },
      );
      await waitFor(async () => merges('merge_replayed') > replayed, {
        description: 'replay skipped',
      });
      expect(await t.aggregate('all', ws('12:00'))).toEqual([[B, 35]]);
    });

    it('S35 AS-32: a crash loses nothing: the restart resumes at the earliest unmerged offset and ends equal to an uninterrupted run', async () => {
      const products = [randomUUID(), randomUUID(), randomUUID()];
      const script = () => [
        ...views(products[0], '12:00:10', 3),
        ...views(products[1], '12:01:10', 4),
        ...views(products[2], '12:02:10', 5),
        ...views(products[0], '12:02:20', 2),
      ];
      const read = async (t: TrendingTestApp) => [
        await t.aggregate('all', ws('12:00')),
        await t.aggregate('all', ws('12:01')),
        await t.aggregate('all', ws('12:02')),
      ];

      // uninterrupted run
      const first = await boot();
      await first.produce([...script(), closer()]);
      await first.settle();
      const expected = await read(first);
      expect(expected.flat()).not.toHaveLength(0);
      await first.close();
      apps.splice(apps.indexOf(first), 1);

      // interrupted run: events consumed, three windows open and unmerged
      const t = await boot();
      await t.produce(script());
      await t.settle();
      expect(await read(t)).toEqual([[], [], []]);
      // the floor is the first offset of the earliest unmerged window, never past it
      expect(await t.committed()).toEqual({ 0: 0 });
      await t.consumer.abandon();

      const second = await createProjectorOnly({
        topic: t.topic,
        groupId: t.groupId,
        clock: t.clock,
      });
      apps.push(second);
      await second.consumer.whenReady();
      await t.produce([closer()]);
      await waitFor(
        async () => (await t.aggregate('all', ws('12:02'))).length > 0,
        {
          description: 'rebuilt windows merged',
        },
      );
      expect(await read(t)).toEqual(expected);
    });

    it('S35 AS-33: two owners of one partition merge a window once, and two partitions merging at once both add', async () => {
      const t = await boot();
      const A = randomUUID();
      await t.produce([...views(A, '12:00:10', 4), closer()]);
      await t.settle();
      // a second owner (another group on the same topic) rebuilds and merges the same window of the same partition
      const other = await createProjectorOnly({
        topic: t.topic,
        groupId: `${t.groupId}-other`,
        clock: t.clock,
      });
      apps.push(other);
      await other.consumer.whenReady();
      await waitFor(async () => (other.ingest.positions().get(0) ?? -1) >= 4, {
        description: 'second owner consumed',
      });
      await sleep(200);
      expect(await t.aggregate('all', ws('12:00'))).toEqual([[A, 4]]);

      // two real merges at once, different partitions of one window
      const writer = t.app.get(RedisTrendingAggregateAdapter, {
        strict: false,
      });
      const [P, Q] = [randomUUID(), randomUUID()];
      const start = ws('13:00');
      const merge = (partition: number, productId: string, score: number) =>
        writer.mergeWindow({
          partition,
          windowStartMs: start,
          firstOffset: 0,
          lastOffset: 1,
          categories: [{ category: 'all', entries: [{ productId, score }] }],
        });
      const results = await Promise.all([
        merge(1, P, 7),
        merge(2, P, 5),
        merge(2, Q, 9),
      ]);
      expect(results.sort()).toEqual(['applied', 'applied', 'replayed']);
      expect(await t.aggregate('all', start)).toEqual([[P, 12]]);
    });

    it('S35 AS-34: a graceful stop merges every open window and commits their offsets; the next instance adds no double count', async () => {
      const t = await boot();
      const [A, B] = [randomUUID(), randomUUID()];
      await t.produce([...views(A, '12:00:10', 3), ...views(B, '12:01:10', 2)]);
      await t.settle();
      expect(await t.aggregate('all', ws('12:00'))).toEqual([]);
      await t.consumer.stop();
      expect(await t.aggregate('all', ws('12:00'))).toEqual([[A, 3]]);
      expect(await t.aggregate('all', ws('12:01'))).toEqual([[B, 2]]);
      expect(await t.committed()).toEqual({ 0: 5 });

      const next = await createProjectorOnly({
        topic: t.topic,
        groupId: t.groupId,
        clock: t.clock,
      });
      apps.push(next);
      await next.consumer.whenReady();
      await t.produce([...views(A, '12:02:10', 1), closer()]);
      await waitFor(
        async () => (await t.aggregate('all', ws('12:02'))).length > 0,
        { description: 'next instance merged' },
      );
      expect(await t.aggregate('all', ws('12:00'))).toEqual([[A, 3]]);
      expect(await t.aggregate('all', ws('12:02'))).toEqual([[A, 1]]);
    });
  });

  describe('the aggregate store fails', () => {
    it('S35 AS-35: while the store is down the merge is retried at most three times, nothing is committed past the window, and it merges once when the store returns', async () => {
      const t = await boot({ redisProxy: true });
      const B = randomUUID();
      const failed = merges('merge_failed');
      t.redisProxy!.mode = 'refuse';
      await t.produce([...views(B, '12:00:10', 6), closer()]);
      await t.settle();
      expect(merges('merge_failed') - failed).toBeGreaterThanOrEqual(1);
      expect(await t.committed()).toEqual({ 0: 0 }); // not past the unmerged window
      t.redisProxy!.mode = 'pass';
      await sleep(300); // let the client reconnect
      await t.consumer.tickNow();
      expect(await t.aggregate('all', ws('12:00'))).toEqual([[B, 6]]);
      expect((await t.committed())[0]).toBeGreaterThan(0);
    });

    it('S35 AS-35: a merge whose acknowledgement is lost is retried and still counts once (all or nothing)', async () => {
      const t = await boot({ redisProxy: true });
      const B = randomUUID();
      await t.produce(views(B, '12:00:10', 6));
      await t.settle();
      // the writes land, the acknowledgements never arrive: every attempt of the cycle times out
      t.redisProxy!.mode = 'drop-acks';
      const failed = merges('merge_failed');
      await t.produce([closer()]);
      await waitFor(async () => merges('merge_failed') > failed, {
        description: 'cycle gave up',
      });
      t.redisProxy!.mode = 'pass';
      t.redisProxy!.sever();
      await sleep(300); // the client reconnects
      expect(await t.committed()).toEqual({ 0: 0 }); // the window still holds the floor
      await t.consumer.tickNow();
      // the retry found its merge record: applied once, not once per attempt
      expect(await t.aggregate('all', ws('12:00'))).toEqual([[B, 6]]);
      expect(await t.aggregate('audio', ws('12:00'))).toEqual([[B, 6]]);
      expect((await t.committed())[0]).toBeGreaterThan(0);
    });

    it('S35 AS-35: at the memory budget the partition pauses instead of dropping events, and resumes when the store returns', async () => {
      const t = await boot({
        redisProxy: true,
        // one open window holds about 1 MiB, so two of them reach the budget
        env: { TRENDING_MEMORY_BUDGET_MB: '2', TRENDING_ALL_WIDTH: '65536' },
      });
      const [B, C] = [randomUUID(), randomUUID()];
      t.redisProxy!.mode = 'refuse';
      await t.produce([...views(B, '12:00:10', 3), closer()]);
      await waitFor(async () => (t.ingest.positions().get(0) ?? -1) >= 3, {
        description: 'first batch consumed',
      });
      const consumed = t.ingest.positions().get(0)!;
      await t.produce(views(C, '12:00:20', 5));
      await sleep(800);
      expect(t.ingest.positions().get(0)).toBe(consumed); // paused: buffered in the log, not dropped
      t.redisProxy!.mode = 'pass';
      await sleep(300);
      await t.consumer.tickNow();
      await t.settle();
      await t.consumer.tickNow();
      expect(await t.aggregate('all', ws('12:00'))).toEqual(
        expect.arrayContaining([[B, 3]]),
      );
    });
  });

  it('S35 AS-26: the merged aggregate of a window carries a bounded TTL', async () => {
    const t = await boot();
    const A = randomUUID();
    await t.produce([...views(A, '12:00:10', 2), closer()]);
    await t.settle();
    const ttl = await t.ttl(aggregateKey('all', ws('12:00')));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_800);
    expect(await t.ttl(mergeKey(0, ws('12:00')))).toBeGreaterThan(0);
  });
});
