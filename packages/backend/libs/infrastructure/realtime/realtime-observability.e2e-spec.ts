import { Logger } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
import { openSse, type OpenSse } from '@app/test/utils/sse-client';
import { TopicSubscriber } from './hub/topic-subscriber.service';

const counter = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;
const latencySamples = () =>
  MetricsRegistry.histogramValue('realtime_delivery_latency_seconds')?.count ??
  0;

const CLOSED = [
  'client',
  'slow',
  'stalled',
  'lifetime',
  'expired',
  'shutdown',
  'revoked',
  'error',
];
const REFUSED = [
  'invalid',
  'unauthenticated',
  'forbidden',
  'too_many',
  'rate_limited',
  'policy_unavailable',
  'unavailable',
  'capacity',
];
const DELIVERED = ['replayable', 'live_only', 'replayed'];
const PUBLISHED = ['ok', 'failed', 'rejected'];

/** S51 US12 (AS-69, AS-70): metrics with closed label sets and structured logs without secrets. */
describe('S51 observability (OBS)', () => {
  let rt: RealtimeTestApp;
  const open: OpenSse[] = [];
  beforeAll(async () => {
    rt = await createRealtimeApp({});
  });
  afterAll(async () => {
    await rt.close();
  });
  afterEach(() => {
    while (open.length) open.pop()!.close();
    jest.restoreAllMocks();
  });
  const track = async (url: string, headers: Record<string, string> = {}) => {
    const stream = await openSse(url, { headers });
    open.push(stream);
    return stream;
  };
  const until = async (check: () => boolean, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('condition not reached');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('S51 AS-69: counters, gauges and the latency histogram move exactly as the run implies, with closed label sets', async () => {
    const topic = `stream:${freshId()}` as const;
    const before = {
      replayable: counter('realtime_events_delivered_total', {
        kind: 'replayable',
      }),
      liveOnly: counter('realtime_events_delivered_total', {
        kind: 'live_only',
      }),
      ok: counter('realtime_publish_total', { result: 'ok' }),
      rejected: counter('realtime_publish_total', { result: 'rejected' }),
      invalid: counter('realtime_connections_refused_total', {
        reason: 'invalid',
      }),
      client: counter('realtime_connections_closed_total', {
        reason: 'client',
      }),
      ignored: counter('realtime_cursor_ignored_total'),
      listenerErrors: counter('realtime_listener_errors_total'),
      latency: latencySamples(),
      connections: counter('realtime_connections'),
    };

    // an unusable cursor is ignored and counted; the connection is still served
    const viewer = await track(rt.url(topic), {
      'last-event-id': 'not-a-cursor',
    });
    expect(viewer.status).toBe(200);
    await viewer.waitFor((f) => f.some((x) => x.retry !== undefined));
    expect(counter('realtime_connections')).toBe(before.connections + 1);

    const subscriber = rt.app.get(TopicSubscriber);
    const release = await subscriber.subscribe(topic, () => {
      throw new Error('boom');
    });

    await rt.publisher.publish(topic, 'tick', { n: 1 });
    await rt.publisher.publish(topic, 'live', { n: 2 }, { replay: false });
    await expect(
      rt.publisher.publish(topic, 'Not A Type', { n: 3 }),
    ).rejects.toThrow();
    await viewer.waitFor((f) => f.filter((x) => x.event).length >= 2);
    await until(
      () =>
        counter('realtime_listener_errors_total') >= before.listenerErrors + 2,
    );

    const refused = await openSse(rt.url('nope:1'));
    expect(refused.status).toBe(400);

    expect(
      counter('realtime_events_delivered_total', { kind: 'replayable' }),
    ).toBe(before.replayable + 1);
    expect(
      counter('realtime_events_delivered_total', { kind: 'live_only' }),
    ).toBe(before.liveOnly + 1);
    expect(counter('realtime_publish_total', { result: 'ok' })).toBe(
      before.ok + 2,
    );
    expect(counter('realtime_publish_total', { result: 'rejected' })).toBe(
      before.rejected + 1,
    );
    expect(
      counter('realtime_connections_refused_total', { reason: 'invalid' }),
    ).toBe(before.invalid + 1);
    expect(counter('realtime_cursor_ignored_total')).toBe(before.ignored + 1);
    expect(counter('realtime_listener_errors_total')).toBe(
      before.listenerErrors + 2,
    );
    expect(latencySamples()).toBe(before.latency + 2);

    await release();
    viewer.close();
    await until(
      () =>
        counter('realtime_connections_closed_total', { reason: 'client' }) >=
        before.client + 1,
    );
    expect(counter('realtime_connections')).toBe(before.connections);

    // label values come only from the closed lists: never a topic, a user or a cursor
    const allowed: Record<string, string[]> = {
      realtime_events_delivered_total: DELIVERED,
      realtime_publish_total: PUBLISHED,
      realtime_connections_closed_total: CLOSED,
      realtime_connections_refused_total: REFUSED,
    };
    for (const [name, values] of Object.entries(allowed))
      for (const labels of MetricsRegistry.labelSets(name))
        for (const value of Object.values(labels))
          expect(values).toContain(String(value));
    for (const name of [
      'realtime_connections',
      'realtime_topic_subscriptions',
      'realtime_resync_total',
      'realtime_revocations_total',
      'realtime_cursor_ignored_total',
      'realtime_listener_errors_total',
      'realtime_replay_overflow_total',
      'realtime_delivery_latency_seconds',
    ])
      for (const labels of MetricsRegistry.labelSets(name))
        expect(Object.keys(labels)).toEqual([]);
  });

  it('S51 AS-70: one structured line at open and one at close with the request id, and no secret, cursor or payload anywhere', async () => {
    const lines: unknown[] = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => void lines.push(message));
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => void lines.push(message));

    const user = await rt.newUser();
    const topic = `stream:${freshId()}` as const;
    const cursor = `${topic}~1700000000000-0`;
    const viewer = await track(rt.url(topic), {
      authorization: user.bearer,
      'last-event-id': cursor,
    });
    expect(viewer.status).toBe(200);
    await viewer.waitFor((f) => f.some((x) => x.retry !== undefined));
    await rt.publisher.publish(topic, 'tick', { secret: 'payload-marker-xyz' });
    await viewer.waitFor((f) => f.some((x) => x.event === 'tick'));
    viewer.close();
    await until(() =>
      lines.some(
        (l) => (l as { event?: string })?.event === 'realtime.stream.close',
      ),
    );

    const mine = lines.filter(
      (l): l is Record<string, unknown> =>
        typeof l === 'object' &&
        l !== null &&
        String((l as { event?: string }).event).startsWith('realtime.stream.'),
    );
    const opened = mine
      .filter((l) => l.event === 'realtime.stream.open')
      .at(-1)!;
    const closedLine = mine
      .filter((l) => l.event === 'realtime.stream.close')
      .at(-1)!;
    expect(opened).toMatchObject({ topics: 1, principal: 'user' });
    expect(typeof opened.requestId).toBe('string');
    expect(typeof opened.instance).toBe('string');
    expect(closedLine).toMatchObject({ reason: 'client', events: 1 });
    expect(closedLine.requestId).toBe(opened.requestId);
    expect(typeof closedLine.durationMs).toBe('number');

    const everything = JSON.stringify(lines);
    for (const secret of [
      user.bearer.replace('Bearer ', ''),
      cursor,
      '1700000000000-0',
      'payload-marker-xyz',
    ])
      expect(everything).not.toContain(secret);
  });
});
