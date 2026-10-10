import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
import {
  openSse,
  openStalledSocket,
  readSse,
  type OpenSse,
} from '@app/test/utils/sse-client';

const closed = (reason: string) =>
  MetricsRegistry.value('realtime_connections_closed_total', { reason }) ?? 0;
const connections = () => MetricsRegistry.value('realtime_connections') ?? 0;
const big = () => ({ pad: 'p'.repeat(30_000) });

/** S51 US6 (AS-44 to AS-49): slow or greedy clients cannot hurt the instance. */
describe('S51 limits (LIMIT)', () => {
  const open: OpenSse[] = [];
  const extras: Array<() => void> = [];
  const track = async (url: string, headers: Record<string, string> = {}) => {
    const stream = await openSse(url, { headers });
    open.push(stream);
    return stream;
  };
  afterEach(() => {
    while (open.length) open.pop()!.close();
    while (extras.length) extras.pop()!();
  });

  /** Publishes until `done()` holds (the kernel buffers between server and a non-reading client absorb a few MB first). */
  const publishUntil = async (
    rt: RealtimeTestApp,
    topic: `stream:${string}`,
    done: () => boolean,
  ) => {
    await waitFor(
      async () => {
        await Promise.all(
          Array.from({ length: 10 }, () =>
            rt.publisher.publish(topic, 'tick', big(), { replay: false }),
          ),
        );
        return done();
      },
      { timeoutMs: 60_000, intervalMs: 5 },
    );
  };

  describe('backpressure', () => {
    let rt: RealtimeTestApp;
    beforeAll(async () => {
      rt = await createRealtimeApp({
        config: { maxBufferedBytes: 1024 * 1024, stallMs: 30_000 },
      });
    });
    afterAll(async () => {
      await rt.close();
    });

    it('S51 AS-44: a slow consumer is dropped at the byte bound; healthy viewers are unaffected', async () => {
      const topic = `stream:${freshId()}` as const;
      const healthy = await track(rt.url(topic));
      const slow = await openStalledSocket(
        rt.port,
        `/api/streams?topics=${topic}`,
      );
      extras.push(slow.close);
      await waitFor(async () => rt.hub.listenerCount() === 2, {
        timeoutMs: 5_000,
        intervalMs: 25,
      });
      const before = closed('slow');

      await publishUntil(rt, topic, () => closed('slow') > before);
      expect(closed('slow')).toBe(before + 1);
      await waitFor(async () => rt.hub.listenerCount() === 1, {
        timeoutMs: 5_000,
        intervalMs: 25,
      });

      expect(healthy.ended).toBe(false);
      const marker = await rt.publisher.publish(
        topic,
        'marker',
        { ok: true },
        { replay: false },
      );
      expect(marker.published).toBe(true);
      await healthy.waitFor((f) => f.some((x) => x.event === 'marker'));
    });
  });

  describe('stall', () => {
    let rt: RealtimeTestApp;
    beforeAll(async () => {
      rt = await createRealtimeApp({
        config: { maxBufferedBytes: 64 * 1024 * 1024, stallMs: 400 },
      });
    });
    afterAll(async () => {
      await rt.close();
    });

    it('S51 AS-45: a writer blocked longer than the stall limit is dropped', async () => {
      const topic = `stream:${freshId()}` as const;
      const slow = await openStalledSocket(
        rt.port,
        `/api/streams?topics=${topic}`,
      );
      extras.push(slow.close);
      await waitFor(async () => rt.hub.listenerCount() === 1, {
        timeoutMs: 5_000,
        intervalMs: 25,
      });
      const before = closed('stalled');

      await publishUntil(rt, topic, () => closed('stalled') > before);
      expect(closed('stalled')).toBe(before + 1);
      await waitFor(async () => rt.hub.listenerCount() === 0, {
        timeoutMs: 5_000,
        intervalMs: 25,
      });
    });
  });

  describe('replay-phase buffer', () => {
    let rt: RealtimeTestApp;
    beforeAll(async () => {
      rt = await createRealtimeApp({ config: { replayBuffer: 5 } });
    });
    afterAll(async () => {
      await rt.close();
    });

    it('S51 AS-46: live messages beyond the replay buffer are discarded, the replay continues, and nothing is lost', async () => {
      const topic = `stream:${freshId()}` as const;
      const first = await rt.publisher.publish(topic, 'old', big());
      for (let batch = 0; batch < 12; batch++)
        await Promise.all(
          Array.from({ length: 50 }, () =>
            rt.publisher.publish(topic, 'old', big()),
          ),
        );
      const overflow = () =>
        MetricsRegistry.value('realtime_replay_overflow_total') ?? 0;
      const before = overflow();

      // a reader that has not started reading holds the replay open (the server waits for it to drain)
      const viewer = await track(rt.url(topic), {
        'last-event-id': `${topic}~${first.id}`,
      });
      viewer.pause();
      await waitFor(async () => rt.hub.listenerCount() === 1, {
        timeoutMs: 5_000,
        intervalMs: 25,
      });
      const live: string[] = [];
      for (let n = 0; n < 20; n++) {
        const { id } = await rt.publisher.publish(topic, 'live', { n });
        live.push(id!);
      }
      expect(overflow()).toBeGreaterThan(before);

      viewer.resume();
      await viewer.waitFor(
        (f) => f.filter((x) => x.event === 'live').length === 20,
        20_000,
      );
      expect(viewer.ended).toBe(false);
      const positions = viewer.events.map((e) => e.id!.split('~')[1]);
      expect(new Set(positions).size).toBe(positions.length);
      expect(viewer.events.filter((e) => e.event === 'old')).toHaveLength(600);
      expect(positions.slice(-20)).toEqual(live);
    });
  });

  describe('caps', () => {
    let rt: RealtimeTestApp;
    beforeAll(async () => {
      rt = await createRealtimeApp({
        config: {
          maxConnectionsPerUser: 3,
          maxConnectionsPerAddress: 2,
          instanceCapacity: 5,
        },
      });
    });
    afterAll(async () => {
      await rt.close();
    });

    it('S51 AS-47: the per-user and per-address caps answer 429 too_many_connections with Retry-After 5', async () => {
      const alice = await rt.newUser();
      const bob = await rt.newUser();
      const topic = `auction:${freshId()}`;
      const mine = [] as OpenSse[];
      for (let i = 0; i < 3; i++)
        mine.push(await track(rt.url(topic), { authorization: alice.bearer }));
      expect(mine.every((s) => s.status === 200)).toBe(true);

      const fourth = await readSse(rt.url(topic), {
        headers: { authorization: alice.bearer },
        count: 1,
        timeoutMs: 3_000,
      });
      expect(fourth.status).toBe(429);
      expect(problemDetailsSchema.parse(fourth.body).code).toBe(
        'too_many_connections',
      );
      expect(fourth.headers['retry-after']).toBe('5');

      // another user is not affected
      expect(
        (await track(rt.url(topic), { authorization: bob.bearer })).status,
      ).toBe(200);

      // closing one frees a slot
      mine[0].close();
      await waitFor(
        async () =>
          (
            await readSse(rt.url(topic), {
              headers: { authorization: alice.bearer },
              count: 1,
              timeoutMs: 300,
            })
          ).status === 200,
        { timeoutMs: 5_000, intervalMs: 50 },
      );
    });

    it('S51 AS-47: anonymous viewers are capped per client address', async () => {
      const topic = `auction:${freshId()}`;
      await waitFor(async () => connections() === 0, {
        timeoutMs: 5_000,
        intervalMs: 25,
      });
      const a = await track(rt.url(topic));
      const b = await track(rt.url(topic));
      expect([a.status, b.status]).toEqual([200, 200]);
      const third = await readSse(rt.url(topic), {
        count: 1,
        timeoutMs: 3_000,
      });
      expect(third.status).toBe(429);
      expect(third.headers['retry-after']).toBe('5');
    });

    it('S51 AS-48: an instance at capacity answers 503 realtime_capacity with a jittered Retry-After of 1 to 5', async () => {
      const users = await Promise.all(
        Array.from({ length: 3 }, () => rt.newUser()),
      );
      const topic = `auction:${freshId()}`;
      await waitFor(async () => connections() === 0, {
        timeoutMs: 5_000,
        intervalMs: 25,
      });
      for (let i = 0; i < 5; i++)
        await track(rt.url(topic), { authorization: users[i % 3].bearer });
      expect(connections()).toBe(5);

      const refused = await readSse(rt.url(topic), {
        headers: { authorization: users[0].bearer },
        count: 1,
        timeoutMs: 3_000,
      });
      expect(refused.status).toBe(503);
      expect(problemDetailsSchema.parse(refused.body).code).toBe(
        'realtime_capacity',
      );
      const retryAfter = Number(refused.headers['retry-after']);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(5);
    });
  });

  describe('realtime.connect policy', () => {
    it('S51 AS-49: 60 new connections a minute per user, then 429 with the S50 problem', async () => {
      const rt = await createRealtimeApp({ realRateLimit: true });
      try {
        const user = await rt.newUser();
        const topic = `auction:${freshId()}`;
        for (let i = 0; i < 60; i++) {
          const stream = await openSse(rt.url(topic), {
            headers: { authorization: user.bearer },
          });
          expect(stream.status).toBe(200);
          stream.close();
        }
        const limited = await readSse(rt.url(topic), {
          headers: { authorization: user.bearer },
          count: 1,
          timeoutMs: 3_000,
        });
        expect(limited.status).toBe(429);
        expect(problemDetailsSchema.parse(limited.body).code).toBe(
          'rate_limited',
        );
        expect(limited.headers['retry-after']).toBeDefined();
        // a different user has their own allowance
        const other = await rt.newUser();
        const ok = await openSse(rt.url(topic), {
          headers: { authorization: other.bearer },
        });
        expect(ok.status).toBe(200);
        ok.close();
      } finally {
        await rt.close();
      }
    });

    it('S51 AS-49: the policy fails open when the limiter store is unreachable', async () => {
      const rt = await createRealtimeApp({ realRateLimit: true });
      try {
        const unavailable = () =>
          MetricsRegistry.value('rate_limit_store_unavailable_total', {
            policy: 'realtime.connect',
            fail_mode: 'open',
          }) ?? 0;
        const before = unavailable();
        rt.redis.client.disconnect(); // the limiter shares this store client
        const res = await readSse(rt.url(`auction:${freshId()}`), {
          count: 1,
          timeoutMs: 5_000,
        });
        // not refused by the limiter: the request got through it (the stream then needs the same store and says so)
        expect(res.status).not.toBe(429);
        expect(problemDetailsSchema.parse(res.body).code).not.toBe(
          'rate_limiter_unavailable',
        );
        expect(unavailable()).toBeGreaterThan(before);
      } finally {
        await rt.app.close().catch(() => undefined);
      }
    });
  });
});
