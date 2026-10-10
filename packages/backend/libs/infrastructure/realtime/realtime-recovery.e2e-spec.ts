import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
import { openSse, readSse, type OpenSse } from '@app/test/utils/sse-client';

const storeUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');

/**
 * S51 US11 (AS-38, AS-66 to AS-68): a lost or restarted backplane heals without clients noticing. The hub's subscriber
 * connection runs through a real TCP fault proxy; the publishing client does not, so events keep being stored while the
 * backplane is cut.
 */
describe('S51 recovery (REC)', () => {
  let proxy: TcpFaultProxy;
  const open: OpenSse[] = [];
  const track = async (url: string, headers: Record<string, string> = {}) => {
    const stream = await openSse(url, { headers });
    open.push(stream);
    return stream;
  };
  const numbers = (
    events: { data?: string; event?: string }[],
    type = 'price',
  ) =>
    events
      .filter((e) => e.event === type)
      .map((e) => (JSON.parse(e.data!).data as { n: number }).n);

  beforeAll(async () => {
    proxy = await TcpFaultProxy.start({
      host: storeUrl.hostname,
      port: Number(storeUrl.port || 6379),
    });
  });
  afterAll(async () => {
    await proxy.close();
  });
  afterEach(() => {
    proxy.mode = 'pass';
    while (open.length) open.pop()!.close();
  });

  const viaProxy = () =>
    createRealtimeApp({
      config: {
        subscriberUrl: `redis://127.0.0.1:${proxy.port}/0`,
        subscribeTimeoutMs: 400,
      },
    });
  const cutBackplane = async (rt: RealtimeTestApp) => {
    proxy.mode = 'refuse';
    proxy.sever();
    await waitFor(async () => rt.hub.backplaneStatus() !== 'ready', {
      timeoutMs: 5_000,
      intervalMs: 10,
    });
  };
  const healBackplane = async (rt: RealtimeTestApp) => {
    proxy.mode = 'pass';
    await waitFor(async () => rt.hub.backplaneStatus() === 'ready', {
      timeoutMs: 15_000,
      intervalMs: 25,
    });
  };

  it('S51 AS-38: a subscribe that fails leaves no residue and answers 503; a retry works once the backplane is back', async () => {
    const rt = await viaProxy();
    try {
      const warm = await track(rt.url(`auction:${freshId()}`));
      expect(warm.status).toBe(200);
      warm.close();
      await waitFor(async () => rt.hub.channelCount() === 0, {
        timeoutMs: 5_000,
        intervalMs: 25,
      });

      await cutBackplane(rt);
      const topic = `auction:${freshId()}` as const;
      const refused = await readSse(rt.url(topic), {
        count: 1,
        timeoutMs: 3_000,
      });
      expect(refused.status).toBe(503);
      expect(problemDetailsSchema.parse(refused.body).code).toBe(
        'realtime_unavailable',
      );
      expect(rt.hub.channelCount()).toBe(0);
      expect(rt.hub.listenerCount()).toBe(0);

      await healBackplane(rt);
      const retry = await track(rt.url(topic));
      expect(retry.status).toBe(200);
      await rt.publisher.publish(topic, 'price', { n: 1 });
      await retry.waitFor((f) => f.some((x) => x.event === 'price'));
    } finally {
      await rt.close();
    }
  });

  it('S51 AS-66: after a backplane blip every open viewer is caught up from its cursor, in order, exactly once', async () => {
    const rt = await viaProxy();
    try {
      const topic = `auction:${freshId()}` as const;
      const other = `stream:${freshId()}` as const;
      const viewer = await track(rt.url(topic, other));
      await rt.publisher.publish(topic, 'price', { n: 1 });
      await viewer.waitFor((f) => f.some((x) => x.event === 'price'));

      await cutBackplane(rt);
      await rt.publisher.publish(topic, 'price', { n: 2 }); // stored while the backplane is down
      await rt.publisher.publish(topic, 'price', { n: 3 });
      await rt.publisher.publish(other, 'tick', { n: 1 }, { replay: false }); // live-only: lost, by contract
      await healBackplane(rt);

      await viewer.waitFor(
        (f) => f.filter((x) => x.event === 'price').length === 3,
        10_000,
      );
      await rt.publisher.publish(topic, 'price', { n: 4 });
      await viewer.waitFor(
        (f) => f.filter((x) => x.event === 'price').length === 4,
      );
      expect(numbers(viewer.events)).toEqual([1, 2, 3, 4]);
      expect(viewer.events.filter((e) => e.event === 'tick')).toHaveLength(0);
      expect(viewer.ended).toBe(false);
    } finally {
      await rt.close();
    }
  });

  it('S51 AS-67: with the backplane down at connect time a new connection is refused with 503, and works after recovery', async () => {
    proxy.mode = 'refuse';
    const rt = await viaProxy();
    try {
      const topic = `auction:${freshId()}` as const;
      const refused = await readSse(rt.url(topic), {
        count: 1,
        timeoutMs: 5_000,
      });
      expect(refused.status).toBe(503);
      expect(problemDetailsSchema.parse(refused.body).code).toBe(
        'realtime_unavailable',
      );
      expect(rt.hub.channelCount()).toBe(0);
      expect(rt.hub.listenerCount()).toBe(0);

      proxy.mode = 'pass';
      await waitFor(
        async () =>
          (await readSse(rt.url(topic), { count: 1, timeoutMs: 400 }))
            .status === 200,
        { timeoutMs: 15_000, intervalMs: 100 },
      );
    } finally {
      await rt.close();
    }
  });

  it('S51 AS-68: a replay read that fails midway ends the connection cleanly, and the client resumes from its cursor', async () => {
    const broken = await createRealtimeApp({
      keepStore: true,
      config: { replayPage: 10 },
    });
    const healthy = await createRealtimeApp({ keepStore: true });
    try {
      const topic = `stream:${freshId()}` as const;
      const first = await healthy.publisher.publish(topic, 'tick', {
        pad: 'p'.repeat(30_000),
      });
      for (let batch = 0; batch < 9; batch++)
        await Promise.all(
          Array.from({ length: 100 }, () =>
            healthy.publisher.publish(topic, 'tick', {
              pad: 'p'.repeat(30_000),
            }),
          ),
        );
      const stored = (
        await healthy.redis.client.xrange(`rt:s:${topic}`, `(${first.id}`, '+')
      ).map(([id]) => id);
      expect(stored).toHaveLength(900);
      const replayed = () =>
        MetricsRegistry.value('realtime_events_delivered_total', {
          kind: 'replayed',
        }) ?? 0;
      const before = replayed();

      const viewer = await track(broken.url(topic), {
        'last-event-id': `${topic}~${first.id}`,
      });
      viewer.pause(); // the replay stalls on the full socket, between pages
      // How many events fit in the kernel socket buffers depends on the machine and its load, so wait for the replay to
      // stall (the counter stops moving) instead of for a fixed count.
      let stalledAt = -1;
      let lastSeen = -1;
      let stableSince = Date.now();
      await waitFor(
        async () => {
          const now = replayed() - before;
          if (now !== lastSeen) {
            lastSeen = now;
            stableSince = Date.now();
          }
          stalledAt = now;
          return now >= 10 && Date.now() - stableSince >= 500;
        },
        { timeoutMs: 20_000, intervalMs: 20 },
      );
      expect(stalledAt).toBeLessThan(900);
      broken.redis.client.disconnect(); // the next page read fails
      viewer.resume();

      await viewer.waitForEnd(10_000);
      expect(viewer.complete).toBe(true); // ended, not reset
      expect(viewer.partial).toBe('');
      const got = viewer.events.map((e) => e.id!.split('~')[1]);
      expect(got.length).toBeGreaterThanOrEqual(stalledAt);
      expect(got.length).toBeLessThan(900);

      // resuming from the last cursor it received yields exactly the rest, once
      const resumed = await readSse(healthy.url(topic), {
        headers: {
          'last-event-id': viewer.events[viewer.events.length - 1].id!,
        },
        count: 900 - got.length,
        timeoutMs: 20_000,
      });
      expect([
        ...got,
        ...resumed.events.map((e) => e.id!.split('~')[1]),
      ]).toEqual(stored);
    } finally {
      await broken.app.close().catch(() => undefined);
      await healthy.close();
    }
  });
});
