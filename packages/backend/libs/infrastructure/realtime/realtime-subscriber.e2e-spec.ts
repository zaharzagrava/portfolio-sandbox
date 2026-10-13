import { Logger } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
import { RealtimeUnavailableError } from './errors';
import { TopicSubscriber } from './hub/topic-subscriber.service';
import type { RealtimeMessage } from './topics';

/** S51 US9 (AS-39, AS-41): in-process subscriptions release idempotently and a throwing listener is isolated. */
describe('S51 server-side subscriber (SUB)', () => {
  let rt: RealtimeTestApp;
  let subscriber: TopicSubscriber;

  beforeAll(async () => {
    rt = await createRealtimeApp({});
    subscriber = rt.app.get(TopicSubscriber);
  });
  afterAll(async () => {
    await rt.close();
  });

  it('S51 AS-39: releasing a subscription twice decreases the count once and other listeners keep receiving', async () => {
    const topic = `auction:${freshId()}` as const;
    const first: RealtimeMessage[] = [];
    const second: RealtimeMessage[] = [];
    const base = rt.hub.listenerCount();
    const releaseA = await subscriber.subscribe(topic, (m) => first.push(m));
    const releaseB = await subscriber.subscribe(topic, (m) => second.push(m));
    expect(rt.hub.listenerCount()).toBe(base + 2);

    await releaseA();
    await releaseA();
    expect(rt.hub.listenerCount()).toBe(base + 1);

    await rt.publisher.publish(topic, 'price', { n: 1 });
    await waitFor(async () => second.length === 1, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
    expect(first).toHaveLength(0);

    await releaseB();
    await releaseB();
    expect(rt.hub.listenerCount()).toBe(base);
  });

  it('S51 AS-41: a listener that throws on every message does not stop the other, stays subscribed, and is counted', async () => {
    const topic = `auction:${freshId()}` as const;
    const received: RealtimeMessage[] = [];
    let thrown = 0;
    const errorsBefore =
      MetricsRegistry.value('realtime_listener_errors_total') ?? 0;
    const base = rt.hub.listenerCount();
    const releaseBad = await subscriber.subscribe(topic, () => {
      thrown += 1;
      throw new Error('boom');
    });
    const releaseGood = await subscriber.subscribe(topic, (m) =>
      received.push(m),
    );

    await rt.publisher.publish(topic, 'price', { n: 1 });
    await rt.publisher.publish(topic, 'price', { n: 2 });
    await waitFor(async () => received.length === 2, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });

    expect(thrown).toBe(2);
    expect(rt.hub.listenerCount()).toBe(base + 2);
    expect(
      (MetricsRegistry.value('realtime_listener_errors_total') ?? 0) -
        errorsBefore,
    ).toBe(2);

    await releaseBad();
    await releaseGood();
  });

  it('S51 AS-59: an in-process subscriber gets replayable and live-only events, shares one subscription with a viewer, and stops after release', async () => {
    const topic = `stream:${freshId()}` as const;
    const got: RealtimeMessage[] = [];
    const channelsBefore = rt.hub.channelCount();
    const viewer = await rt.hub.subscribe(topic, () => undefined);
    const release = await subscriber.subscribe(topic, (m) => got.push(m));
    expect(rt.hub.channelCount()).toBe(channelsBefore + 1);

    const stored = await rt.publisher.publish(topic, 'price', { n: 1 });
    await rt.publisher.publish(topic, 'presence', { n: 2 }, { replay: false });
    await waitFor(async () => got.length === 2, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
    expect(got[0]).toEqual({
      id: stored.id,
      topic,
      type: 'price',
      data: { n: 1 },
    });
    expect(got[1]).toMatchObject({ id: '0-0', type: 'presence' });

    await release();
    // a sentinel listener proves the third event went through the hub; the released one must not have seen it
    const sentinel: RealtimeMessage[] = [];
    const releaseSentinel = await subscriber.subscribe(topic, (m) =>
      sentinel.push(m),
    );
    await rt.publisher.publish(topic, 'price', { n: 3 });
    await waitFor(async () => sentinel.length === 1, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
    expect(got).toHaveLength(2);
    await releaseSentinel();
    await viewer();
  });

  describe('discovery', () => {
    it('S51 AS-60: topicsWithSubscribers is sorted, route-exact, fleet-wide, and forgets a topic when its last viewer leaves', async () => {
      const other = await createRealtimeApp({ keepStore: true });
      const a = `a${freshId()}`;
      const b = `b${freshId()}`;
      try {
        const releases = [
          await subscriber.subscribe(
            `shop:${b}:live` as never,
            () => undefined,
          ),
          await subscriber.subscribe(
            `shop:${b}:assets` as never,
            () => undefined,
          ),
          await other.app
            .get(TopicSubscriber)
            .subscribe(`shop:${a}:live` as never, () => undefined),
        ];
        const found = await rt.subscriptions.topicsWithSubscribers(
          'shop',
          'live',
        );
        const mine = found.filter((t) => t.includes(a) || t.includes(b));
        expect(mine).toEqual([`shop:${a}:live`, `shop:${b}:live`]);
        expect(found.every((t) => t.endsWith(':live'))).toBe(true);

        await releases[2]();
        await waitFor(
          async () =>
            !(
              await rt.subscriptions.topicsWithSubscribers('shop', 'live')
            ).includes(`shop:${a}:live`),
          { timeoutMs: 1_000, intervalMs: 25 },
        );
        await releases[0]();
        await releases[1]();
      } finally {
        await other.close();
      }
    });

    it('S51 AS-61: results are capped with a warning, and a store outage rejects RealtimeUnavailableError within the timeout', async () => {
      const capped = await createRealtimeApp({
        keepStore: true,
        config: { discoveryLimit: 3 },
      });
      const cappedSub = capped.app.get(TopicSubscriber);
      const tag = freshId();
      const releases: Array<() => Promise<void>> = [];
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        for (const n of [4, 2, 5, 1, 3])
          releases.push(
            await cappedSub.subscribe(
              `cap:${tag}-${n}` as never,
              () => undefined,
            ),
          );
        const found = await capped.subscriptions.topicsWithSubscribers('cap');
        expect(found).toEqual([`cap:${tag}-1`, `cap:${tag}-2`, `cap:${tag}-3`]);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/capped/i));
        for (const release of releases) await release();

        const pubsub = jest
          .spyOn(capped.redis.client, 'pubsub')
          .mockImplementation(() => new Promise(() => undefined) as never);
        const started = Date.now();
        await expect(
          capped.subscriptions.topicsWithSubscribers('shop', 'live'),
        ).rejects.toBeInstanceOf(RealtimeUnavailableError);
        expect(Date.now() - started).toBeLessThan(2_000);
        pubsub.mockRestore();
      } finally {
        warn.mockRestore();
        await capped.close();
      }
    });
  });
});
