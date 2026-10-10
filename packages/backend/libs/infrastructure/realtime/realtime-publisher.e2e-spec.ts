import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import { inParallel } from '@app/test/utils/async-helpers';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
import { openSse, readSse, type OpenSse } from '@app/test/utils/sse-client';
import {
  InvalidRealtimeEventTypeError,
  InvalidRealtimePayloadError,
  InvalidRealtimeTopicError,
  RealtimePayloadTooLargeError,
} from './errors';
import type { RealtimeTopic } from './topics';

/** S51 US4 (AS-29 to AS-33) and the retention half of AS-20: the publisher, against a real store. */
describe('S51 publisher (PUB)', () => {
  let rt: RealtimeTestApp;
  const open: OpenSse[] = [];

  beforeAll(async () => {
    rt = await createRealtimeApp({
      config: { publishTimeoutMs: 400 },
    });
  });
  afterAll(async () => {
    await rt.close();
  });
  afterEach(() => {
    while (open.length) open.pop()!.close();
  });

  const publishedCount = (result: string) =>
    MetricsRegistry.value('realtime_publish_total', { result }) ?? 0;

  it("S51 AS-29: the returned id is the viewer's cursor and the replayed id", async () => {
    const topic = `auction:${freshId()}` as const;
    const viewer = await openSse(rt.url(topic));
    open.push(viewer);

    const result = await rt.publisher.publish(topic, 'price', { price: 7 });
    expect(result).toEqual({
      published: true,
      id: expect.stringMatching(/^\d+-\d+$/),
    });
    await viewer.waitFor((f) => f.some((x) => x.event === 'price'));
    expect(viewer.events[0].id).toBe(`${topic}~${result.id}`);

    // a reconnect from the cursor before it replays that same event with the same id
    const before = await rt.publisher.publish(topic, 'price', { price: 8 });
    const replay = await readSse(rt.url(topic), {
      headers: { 'last-event-id': `${topic}~${result.id}` },
      count: 1,
      timeoutMs: 5_000,
    });
    expect(replay.events[0].id).toBe(`${topic}~${before.id}`);
    const again = await readSse(rt.url(topic), {
      headers: { 'last-event-id': `${topic}~${result.id}` },
      count: 1,
      timeoutMs: 5_000,
    });
    expect(again.events[0].id).toBe(replay.events[0].id);
  });

  it('S51 AS-30: 200 publishes from two processes are distinct, ordered and complete', async () => {
    const other = await createRealtimeApp({ keepStore: true });
    try {
      const topic = `stream:${freshId()}` as const;
      const viewer = await openSse(rt.url(topic));
      open.push(viewer);

      const results = await inParallel(200, (i) =>
        (i % 2 ? other : rt).publisher.publish(topic, 'tick', { i }),
      );
      const ids = results.map((r) => {
        expect(r.status).toBe('fulfilled');
        const value = (
          r as PromiseFulfilledResult<{ published: boolean; id: string }>
        ).value;
        expect(value.published).toBe(true);
        return value.id;
      });
      expect(new Set(ids).size).toBe(200);

      await viewer.waitFor(
        (f) => f.filter((x) => x.event === 'tick').length === 200,
        10_000,
      );
      const delivered = viewer.events.map((e) => e.id!.split('~')[1]);
      const sortedIds = [...ids].sort((a, b) => {
        const [am, as] = a.split('-').map(Number);
        const [bm, bs] = b.split('-').map(Number);
        return am - bm || as - bs;
      });
      expect(delivered).toEqual(sortedIds);

      // a replay from the start returns the same 200
      const stored = await rt.redis.client.xrange(`rt:s:${topic}`, '-', '+');
      expect(stored.map(([id]) => id)).toEqual(sortedIds);
    } finally {
      await other.close();
    }
  });

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const invalid: Array<
    [string, string, string, unknown, new (...a: never[]) => Error]
  > = [
    [
      'a topic that breaks the grammar',
      'USER:abc',
      'price',
      {},
      InvalidRealtimeTopicError,
    ],
    [
      'an empty event type',
      'auction:a1',
      '',
      {},
      InvalidRealtimeEventTypeError,
    ],
    [
      'an event type of 65 characters',
      'auction:a1',
      'a'.repeat(65),
      {},
      InvalidRealtimeEventTypeError,
    ],
    [
      'an event type with a space',
      'auction:a1',
      'two words',
      {},
      InvalidRealtimeEventTypeError,
    ],
    [
      'an event type with a newline',
      'auction:a1',
      'a\nb',
      {},
      InvalidRealtimeEventTypeError,
    ],
    [
      'an upper-case event type',
      'auction:a1',
      'Price',
      {},
      InvalidRealtimeEventTypeError,
    ],
    [
      'the reserved type open',
      'auction:a1',
      'open',
      {},
      InvalidRealtimeEventTypeError,
    ],
    [
      'the reserved type error',
      'auction:a1',
      'error',
      {},
      InvalidRealtimeEventTypeError,
    ],
    [
      'the reserved type resync',
      'auction:a1',
      'resync',
      {},
      InvalidRealtimeEventTypeError,
    ],
    [
      'the reserved type revoked',
      'auction:a1',
      'revoked',
      {},
      InvalidRealtimeEventTypeError,
    ],
    [
      'a payload over 32 KiB',
      'auction:a1',
      'price',
      'x'.repeat(33 * 1024),
      RealtimePayloadTooLargeError,
    ],
    [
      'a circular payload',
      'auction:a1',
      'price',
      circular,
      InvalidRealtimePayloadError,
    ],
    [
      'a BigInt payload',
      'auction:a1',
      'price',
      { n: BigInt(1) },
      InvalidRealtimePayloadError,
    ],
    [
      'undefined data',
      'auction:a1',
      'price',
      undefined,
      InvalidRealtimePayloadError,
    ],
  ];

  it.each(invalid)(
    'S51 AS-31: %s rejects with a typed error before the store is touched',
    async (_label, topic, type, data, error) => {
      const before = await rt.redis.client.dbsize();
      await expect(
        rt.publisher.publish(topic as RealtimeTopic, type, data),
      ).rejects.toBeInstanceOf(error);
      expect(await rt.redis.client.dbsize()).toBe(before);
    },
  );

  it.each([['payment.status'], ['delivery_offer'], ['assets.changed']])(
    'S51 AS-31: the event type %s is accepted',
    async (type) => {
      const topic = `auction:${freshId()}` as const;
      await expect(
        rt.publisher.publish(topic, type, {}),
      ).resolves.toMatchObject({
        published: true,
      });
    },
  );

  it('S51 AS-32: a store fault resolves published:false after one attempt, within the timeout', async () => {
    const broken = await createRealtimeApp({
      keepStore: true,
      config: { publishTimeoutMs: 400 },
    });
    try {
      const failedBefore = publishedCount('failed');
      broken.redis.client.disconnect();
      const started = Date.now();
      const result = await broken.publisher.publish(
        `auction:${freshId()}` as const,
        'price',
        {},
      );
      expect(result).toEqual({ published: false, id: null });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(publishedCount('failed')).toBe(failedBefore + 1);
    } finally {
      await broken.app.close().catch(() => undefined);
    }
  });

  it('S51 AS-32: a store that answers later than the timeout resolves published:false and is not retried', async () => {
    const topic = `auction:${freshId()}` as const;
    await rt.publisher.publish(topic, 'warmup', {}); // loads the script, so a retry would show as a second EVALSHA
    await rt.redis.client.config('RESETSTAT');
    const failedBefore = publishedCount('failed');

    await rt.redis.client.client('PAUSE', '1200', 'WRITE');
    const started = Date.now();
    const result = await rt.publisher.publish(topic, 'late', {});
    const elapsed = Date.now() - started;

    expect(result).toEqual({ published: false, id: null });
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(1_000);
    expect(publishedCount('failed')).toBe(failedBefore + 1);

    // the single attempt lands after the pause; nothing issues a second one
    await waitFor(
      async () => {
        const stats = (await rt.redis.client.info('commandstats')) as string;
        return /cmdstat_evalsha:calls=1,/.test(stats);
      },
      { timeoutMs: 5_000, intervalMs: 50 },
    );
    const stats = (await rt.redis.client.info('commandstats')) as string;
    expect(stats).toMatch(/cmdstat_evalsha:calls=1,/);
    expect(stats).not.toMatch(/cmdstat_eval:/);
  });

  it('S51 AS-33: publishing with no viewer succeeds, leaves only the buffer, and a later cursor receives it', async () => {
    const topic = `auction:${freshId()}` as const;
    const first = await rt.publisher.publish(topic, 'price', { n: 1 });
    const second = await rt.publisher.publish(topic, 'price', { n: 2 });
    expect(second.published).toBe(true);
    expect(rt.hub.channelCount()).toBe(0);
    const [, subscribers] = (await rt.redis.client.pubsub(
      'NUMSUB',
      `rt:c:${topic}`,
    )) as [string, number];
    expect(Number(subscribers)).toBe(0);
    expect(await rt.redis.client.xlen(`rt:s:${topic}`)).toBe(2);

    const viewer = await readSse(rt.url(topic), {
      headers: { 'last-event-id': `${topic}~${first.id}` },
      count: 1,
      timeoutMs: 5_000,
    });
    expect(viewer.events[0].id).toBe(`${topic}~${second.id}`);
  });

  describe('S51 AS-20 retention', () => {
    it('keeps at least 1,000 and at most 1,200 events, with a lifetime within the retention age', async () => {
      const topic = `stream:${freshId()}` as const;
      for (let batch = 0; batch < 25; batch++)
        await Promise.all(
          Array.from({ length: 100 }, (_, i) =>
            rt.publisher.publish(topic, 'tick', { n: batch * 100 + i }),
          ),
        );
      const length = await rt.redis.client.xlen(`rt:s:${topic}`);
      expect(length).toBeGreaterThanOrEqual(1_000);
      expect(length).toBeLessThanOrEqual(1_200);
      const ttl = await rt.redis.client.pttl(`rt:s:${topic}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(3_600_000);
    });

    it('a live-only event creates and changes no buffer', async () => {
      const topic = `stream:${freshId()}` as const;
      const result = await rt.publisher.publish(
        topic,
        'tick',
        {},
        { replay: false },
      );
      expect(result).toEqual({ published: true, id: null });
      expect(await rt.redis.client.exists(`rt:s:${topic}`)).toBe(0);
    });

    it('entries older than the retention age are dropped and the key expires as a whole', async () => {
      const short = await createRealtimeApp({
        keepStore: true,
        config: { retentionMs: 1_500 },
      });
      try {
        const topic = `stream:${freshId()}` as const;
        for (let i = 0; i < 3; i++)
          await short.publisher.publish(topic, 'old', { i });
        expect(await short.redis.client.xlen(`rt:s:${topic}`)).toBe(3);
        // poll until the old entries have aged out: each publish trims by the store's clock
        await waitFor(
          async () => {
            await short.publisher.publish(topic, 'new', {});
            const left = await short.redis.client.xrange(
              `rt:s:${topic}`,
              '-',
              '+',
            );
            return !left.some(([, fields]) => fields[1] === 'old');
          },
          { timeoutMs: 6_000, intervalMs: 200 },
        );
        const remaining = await short.redis.client.xrange(
          `rt:s:${topic}`,
          '-',
          '+',
        );
        expect(remaining.every(([, fields]) => fields[1] !== 'old')).toBe(true);
        const ttl = await short.redis.client.pttl(`rt:s:${topic}`);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(1_500);
        // idle for the retention age: no buffer left
        await waitFor(
          async () => (await short.redis.client.exists(`rt:s:${topic}`)) === 0,
          {
            timeoutMs: 6_000,
            intervalMs: 200,
          },
        );
      } finally {
        await short.close();
      }
    });
  });
});
