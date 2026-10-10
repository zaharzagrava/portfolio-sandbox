import * as http from 'node:http';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
import { openSse, type OpenSse } from '@app/test/utils/sse-client';

/** S51 US5 (AS-35 to AS-37, AS-40, AS-42, AS-43): one backplane subscription per topic per instance, no leaks. */
describe('S51 fan-out (FAN)', () => {
  let rt: RealtimeTestApp;
  const open: OpenSse[] = [];
  const track = async (url: string, headers: Record<string, string> = {}) => {
    const stream = await openSse(url, { headers });
    open.push(stream);
    return stream;
  };
  const numsub = async (topic: string) => {
    const [, n] = (await rt.redis.client.pubsub('NUMSUB', `rt:c:${topic}`)) as [
      string,
      number,
    ];
    return Number(n);
  };
  const connections = () => MetricsRegistry.value('realtime_connections') ?? 0;
  const idle = () =>
    waitFor(
      async () =>
        rt.hub.channelCount() === 0 &&
        rt.hub.listenerCount() === 0 &&
        connections() === 0,
      { timeoutMs: 10_000, intervalMs: 25 },
    );

  beforeAll(async () => {
    rt = await createRealtimeApp({
      config: { maxConnectionsPerAddress: 5_000, instanceCapacity: 5_000 },
    });
  });
  afterAll(async () => {
    await rt.close();
  });
  afterEach(async () => {
    while (open.length) open.pop()!.close();
    await idle();
  });

  it('S51 AS-35: 100 viewers of one topic cost one backplane subscription', async () => {
    const topic = `auction:${freshId()}` as const;
    const viewers = await Promise.all(
      Array.from({ length: 100 }, () => track(rt.url(topic))),
    );
    expect(await numsub(topic)).toBe(1);
    expect(rt.hub.channelCount()).toBe(1);
    expect(rt.hub.listenerCount()).toBe(100);

    await rt.publisher.publish(topic, 'price', { n: 1 });
    await Promise.all(
      viewers.map((v) => v.waitFor((f) => f.some((x) => x.event === 'price'))),
    );
    expect(viewers.every((v) => v.events.length === 1)).toBe(true);
  });

  it('S51 AS-36: a leaving viewer does not disturb the others, and the last one releases the subscription', async () => {
    const topic = `auction:${freshId()}` as const;
    const [a, b, c] = await Promise.all(
      [1, 2, 3].map(() => track(rt.url(topic))),
    );
    a.close();
    await waitFor(async () => rt.hub.listenerCount() === 2, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
    expect(await numsub(topic)).toBe(1);

    await rt.publisher.publish(topic, 'price', { n: 1 });
    await b.waitFor((f) => f.some((x) => x.event === 'price'));
    await c.waitFor((f) => f.some((x) => x.event === 'price'));

    b.close();
    c.close();
    await waitFor(async () => (await numsub(topic)) === 0, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
    expect(rt.hub.channelCount()).toBe(0);
  });

  it('S51 AS-37: 50 concurrent first subscribers share one SUBSCRIBE', async () => {
    const warm = await track(rt.url(`auction:${freshId()}`)); // connects the hub and the control channel first
    expect(warm.status).toBe(200);
    const topic = `auction:${freshId()}` as const;
    await rt.redis.client.config('RESETSTAT');

    const releases = await Promise.all(
      Array.from({ length: 50 }, () =>
        rt.hub.subscribe(topic, () => undefined),
      ),
    );
    const stats = (await rt.redis.client.info('commandstats')) as string;
    expect(stats).toMatch(/cmdstat_subscribe:calls=1,/);
    expect(await numsub(topic)).toBe(1);
    await Promise.all(releases.map((release) => release()));
    await waitFor(async () => (await numsub(topic)) === 0, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
  });

  it('S51 AS-40: two instances deliver once to their own viewers; an instance without viewers holds nothing', async () => {
    const b = await createRealtimeApp({ keepStore: true });
    const c = await createRealtimeApp({ keepStore: true });
    try {
      const topic = `auction:${freshId()}` as const;
      const onA = await track(rt.url(topic));
      const onB = await openSse(b.url(topic));
      open.push(onB);
      expect(await numsub(topic)).toBe(2);
      expect(c.hub.channelCount()).toBe(0);

      await c.publisher.publish(topic, 'price', { from: 'c' });
      await onA.waitFor((f) => f.some((x) => x.event === 'price'));
      await onB.waitFor((f) => f.some((x) => x.event === 'price'));
      await c.publisher.publish(topic, 'done', {});
      await onA.waitFor((f) => f.some((x) => x.event === 'done'));
      await onB.waitFor((f) => f.some((x) => x.event === 'done'));
      expect(onA.events.map((e) => e.event)).toEqual(['price', 'done']);
      expect(onB.events.map((e) => e.event)).toEqual(['price', 'done']);
      expect(c.hub.channelCount()).toBe(0);
    } finally {
      await b.close();
      await c.close();
    }
  });

  it('S51 AS-42: 500 connect/close cycles and 100 aborts leave nothing behind', async () => {
    const topic = `auction:${freshId()}` as const;
    for (let round = 0; round < 20; round++)
      await Promise.all(
        Array.from({ length: 25 }, async () => {
          const stream = await openSse(rt.url(topic));
          stream.close();
        }),
      );
    // aborts: the client leaves while the request is still being admitted
    await Promise.all(
      Array.from({ length: 100 }, () => {
        return new Promise<void>((resolve) => {
          const req = http.get(rt.url(topic), () => undefined);
          req.on('error', () => resolve());
          req.on('close', () => resolve());
          setImmediate(() => req.destroy());
        });
      }),
    );
    await idle();
    expect(rt.hub.channelCount()).toBe(0);
    expect(rt.hub.listenerCount()).toBe(0);
    expect(connections()).toBe(0);
    await waitFor(async () => (await numsub(topic)) === 0, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
  });

  it('S51 AS-43: a viewer that aborts during replay stops receiving writes', async () => {
    const topic = `stream:${freshId()}` as const;
    // 950 events of 30 KB stay inside the 1,000-event buffer, so the cursor is replayable, and are far larger than the socket buffers
    const first = await rt.publisher.publish(topic, 'tick', {
      pad: 'p'.repeat(30_000),
    });
    for (let batch = 0; batch < 19; batch++)
      await Promise.all(
        Array.from({ length: 50 }, () =>
          rt.publisher.publish(topic, 'tick', { pad: 'p'.repeat(30_000) }),
        ),
      );
    const replayed = () =>
      MetricsRegistry.value('realtime_events_delivered_total', {
        kind: 'replayed',
      }) ?? 0;
    const before = replayed();

    const viewer = await track(rt.url(topic), {
      'last-event-id': `${topic}~${first.id}`,
    });
    await viewer.waitFor((f) => f.some((x) => x.event === 'tick'));
    viewer.close();
    await idle();

    const atClose = replayed();
    await rt.redis.client.ping();
    await rt.redis.client.ping();
    expect(replayed()).toBe(atClose);
    expect(atClose - before).toBeLessThan(950);
    expect(rt.hub.channelCount()).toBe(0);
  });
});
