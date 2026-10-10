import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
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
});
