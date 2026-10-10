import {
  resyncDataSchema,
  streamEventEnvelopeSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { inParallel, waitFor } from '@app/test/utils/async-helpers';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
import { openSse, readSse, type OpenSse } from '@app/test/utils/sse-client';
import { comparePositions } from './topics';

/** S51 US2 (AS-07 to AS-19): exact resume, baseline, resync. */
describe('S51 replay (REPLAY)', () => {
  let rt: RealtimeTestApp;
  const open: OpenSse[] = [];
  const track = async (url: string, headers: Record<string, string> = {}) => {
    const stream = await openSse(url, { headers });
    open.push(stream);
    return stream;
  };

  beforeAll(async () => {
    rt = await createRealtimeApp();
  });
  afterAll(async () => {
    await rt.close();
  });
  afterEach(async () => {
    while (open.length) open.pop()!.close();
    await waitFor(async () => rt.hub.channelCount() === 0, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
  });

  const publishMany = async (
    topic: `${string}:${string}`,
    n: number,
    type = 'price',
  ) => {
    const ids: string[] = [];
    for (let i = 1; i <= n; i++) {
      const { id } = await rt.publisher.publish(topic as never, type, { n: i });
      ids.push(id!);
    }
    return ids;
  };
  const numbers = (events: { data?: string }[]) =>
    events.map((e) => (JSON.parse(e.data!).data as { n: number }).n);
  const cursorOf = (topic: string, id: string) => `${topic}~${id}`;

  it('S51 AS-07: live-only events carry no id and leave the cursor untouched', async () => {
    const topic = `stream:${freshId()}` as const;
    const viewer = await track(rt.url(topic));
    await rt.publisher.publish(topic, 'tick', { live: 1 }, { replay: false });
    const stored = await rt.publisher.publish(topic, 'tick', { stored: 1 });
    await rt.publisher.publish(topic, 'tick', { live: 2 }, { replay: false });
    await viewer.waitFor(
      (f) => f.filter((x) => x.event === 'tick').length === 3,
    );

    expect(viewer.events.map((e) => e.id)).toEqual([
      undefined,
      cursorOf(topic, stored.id!),
      undefined,
    ]);
  });

  it('S51 AS-08: replays exactly the events after the cursor, then continues live', async () => {
    const topic = `auction:${freshId()}` as const;
    const ids = await publishMany(topic, 5);
    const viewer = await track(rt.url(topic), {
      'last-event-id': cursorOf(topic, ids[1]),
    });
    await viewer.waitFor(
      (f) => f.filter((x) => x.event === 'price').length === 3,
    );
    expect(numbers(viewer.events)).toEqual([3, 4, 5]);
    expect(viewer.events[2].id).toBe(cursorOf(topic, ids[4]));

    await rt.publisher.publish(topic, 'price', { n: 6 });
    await viewer.waitFor(
      (f) => f.filter((x) => x.event === 'price').length === 4,
    );
    expect(numbers(viewer.events)).toEqual([3, 4, 5, 6]);
  });

  it('S51 AS-09: events published while the replay runs are neither lost nor duplicated', async () => {
    const topic = `stream:${freshId()}` as const;
    const [first] = await publishMany(topic, 1);
    // 300 publishers race the connect: some land before the subscribe, some during replay, some after
    const publishing = inParallel(300, (i) =>
      rt.publisher.publish(topic, 'tick', { n: i + 2 }),
    );
    const viewer = await track(rt.url(topic), {
      'last-event-id': cursorOf(topic, first),
    });
    await publishing;
    await viewer.waitFor(
      (f) => f.filter((x) => x.event === 'tick').length >= 300,
      10_000,
    );
    // a short barrier event proves nothing further is in flight
    await rt.publisher.publish(topic, 'barrier', {});
    await viewer.waitFor((f) => f.some((x) => x.event === 'barrier'));

    const positions = viewer.events
      .filter((e) => e.event === 'tick')
      .map((e) => e.id!.split('~')[1]);
    expect(positions).toHaveLength(300);
    expect(new Set(positions).size).toBe(300);
    for (let i = 1; i < positions.length; i++)
      expect(comparePositions(positions[i], positions[i - 1])).toBeGreaterThan(
        0,
      );
    const stored = (
      await rt.redis.client.xrange(`rt:s:${topic}`, `(${first}`, '+')
    ).filter(([, fields]) => fields[1] === 'tick');
    expect(positions).toEqual(stored.map(([id]) => id));
  });

  it('S51 AS-10: a replay longer than one page arrives complete', async () => {
    const topic = `stream:${freshId()}` as const;
    const ids: string[] = [];
    for (let batch = 0; batch < 8; batch++) {
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          rt.publisher.publish(topic, 'tick', { n: batch * 100 + i }),
        ),
      );
      ids.push(...results.map((r) => r.id!));
    }
    const result = await readSse(rt.url(topic), {
      headers: { 'last-event-id': cursorOf(topic, ids[0]) },
      count: 799,
      timeoutMs: 15_000,
    });
    expect(result.events).toHaveLength(799);
    expect(result.events.map((e) => e.id!.split('~')[1])).toEqual(ids.slice(1));
  });

  it('S51 AS-11: replay is repeatable', async () => {
    const topic = `auction:${freshId()}` as const;
    const ids = await publishMany(topic, 4);
    const read = () =>
      readSse(rt.url(topic), {
        headers: { 'last-event-id': cursorOf(topic, ids[0]) },
        count: 3,
        timeoutMs: 5_000,
      });
    const [a, b] = [await read(), await read()];
    expect(a.events).toEqual(b.events);
    expect(numbers(a.events)).toEqual([2, 3, 4]);
    expect(await rt.redis.client.xlen(`rt:s:${topic}`)).toBe(4);
  });

  it('S51 AS-12: each topic resumes from its own cursor', async () => {
    const a1 = `auction:${freshId()}` as const;
    const a2 = `auction:${freshId()}` as const;
    const x = await publishMany(a1, 5);
    const y = await publishMany(a2, 5);
    const viewer = await track(rt.url(a1, a2), {
      'last-event-id': `${cursorOf(a1, x[1])}|${cursorOf(a2, y[0])}`,
    });
    await viewer.waitFor(
      (f) => f.filter((e) => e.event === 'price').length === 7,
    );
    await rt.publisher.publish(a1, 'barrier', {});
    await viewer.waitFor((f) => f.some((e) => e.event === 'barrier'));

    const byTopic = (topic: string) =>
      numbers(
        viewer.events.filter(
          (e) => e.event === 'price' && JSON.parse(e.data!).topic === topic,
        ),
      );
    expect(byTopic(a1)).toEqual([3, 4, 5]);
    expect(byTopic(a2)).toEqual([2, 3, 4, 5]);
  });

  it('S51 AS-13/AS-14: a first connect gets a baseline and no history; reconnecting from it gets what was missed', async () => {
    const a1 = `auction:${freshId()}` as const;
    const a2 = `auction:${freshId()}` as const;
    const ids = await publishMany(a2, 3);

    const first = await track(rt.url(a1, a2));
    await first.waitFor((f) =>
      f.some((x) => x.id !== undefined && x.event === undefined),
    );
    expect(first.events).toHaveLength(0);
    const baseline = first.frames.find(
      (f) => f.id !== undefined && f.event === undefined,
    )!;
    expect(baseline.id).toBe(cursorOf(a2, ids[2]));
    first.close();

    const missed = await publishMany(a2, 2, 'missed');
    expect(missed).toHaveLength(2);
    const second = await readSse(rt.url(a1, a2), {
      headers: { 'last-event-id': baseline.id! },
      count: 2,
      timeoutMs: 5_000,
    });
    expect(second.events.map((e) => e.event)).toEqual(['missed', 'missed']);
    expect(second.events.map((e) => e.id!.split('~')[1])).toEqual(missed);
  });

  it('S51 AS-15: unusable Last-Event-ID entries are ignored, counted, and never refuse the request', async () => {
    const topic = `auction:${freshId()}` as const;
    await publishMany(topic, 2);
    const ignored = () =>
      MetricsRegistry.value('realtime_cursor_ignored_total') ?? 0;
    const before = ignored();
    const future = `${Date.now() + 10 * 60_000}-0`;
    const header = [
      'garbage',
      `${topic}~abc`,
      'auction:other~5-5',
      'nosuch:1~5-5',
      `${topic}~${future}`,
    ].join('|');

    const viewer = await track(rt.url(topic), { 'last-event-id': header });
    expect(viewer.status).toBe(200);
    await viewer.waitFor((f) =>
      f.some((x) => x.id !== undefined && x.event === undefined),
    );
    expect(viewer.events).toHaveLength(0); // behaves as a first connect
    expect(ignored() - before).toBe(5);

    const tooLong = await track(rt.url(topic), {
      'last-event-id': 'x'.repeat(2_049),
    });
    expect(tooLong.status).toBe(200);
    expect(ignored() - before).toBe(6);

    const empty = await track(rt.url(topic), { 'last-event-id': '' });
    expect(empty.status).toBe(200);
    expect(ignored() - before).toBe(6);
  });

  it('S51 AS-15: duplicate entries — the first wins', async () => {
    const topic = `auction:${freshId()}` as const;
    const ids = await publishMany(topic, 4);
    const result = await readSse(rt.url(topic), {
      headers: {
        'last-event-id': `${cursorOf(topic, ids[0])}|${cursorOf(topic, ids[2])}`,
      },
      count: 3,
      timeoutMs: 5_000,
    });
    expect(numbers(result.events)).toEqual([2, 3, 4]);
  });

  it('S51 AS-16: a cursor older than the trimmed buffer gets one resync, no partial replay, then live', async () => {
    const topic = `stream:${freshId()}` as const;
    const other = `auction:${freshId()}` as const;
    const [first] = await publishMany(topic, 1);
    for (let batch = 0; batch < 13; batch++)
      await Promise.all(
        Array.from({ length: 100 }, () =>
          rt.publisher.publish(topic, 'tick', {}),
        ),
      );
    const otherIds = await publishMany(other, 3);

    const viewer = await track(rt.url(topic, other), {
      'last-event-id': `${cursorOf(topic, first!)}|${cursorOf(other, otherIds[0])}`,
    });
    await viewer.waitFor((f) => f.some((x) => x.event === 'resync'));
    await viewer.waitFor(
      (f) => f.filter((x) => x.event === 'price').length === 2,
    );
    const resyncs = viewer.frames.filter((f) => f.event === 'resync');
    expect(resyncs).toHaveLength(1);
    const payload = streamEventEnvelopeSchema.parse(
      JSON.parse(resyncs[0].data!),
    );
    expect(payload.topic).toBe(topic);
    expect(resyncDataSchema.parse(payload.data)).toEqual({
      reason: 'replay-gap',
    });
    expect(viewer.events.some((e) => e.event === 'tick')).toBe(false); // no partial replay of the trimmed topic
    expect(numbers(viewer.events.filter((e) => e.event === 'price'))).toEqual([
      2, 3,
    ]); // the other topic replays normally

    const live = await rt.publisher.publish(topic, 'tick', { live: true });
    await viewer.waitFor((f) => f.some((x) => x.event === 'tick'));
    expect(viewer.events.find((e) => e.event === 'tick')!.id).toContain(
      cursorOf(topic, live.id!),
    );
  });

  it('S51 AS-17: an expired buffer with an old (or any) cursor gets the same resync', async () => {
    const topic = `auction:${freshId()}` as const;
    const ids = await publishMany(topic, 2);
    await rt.redis.client.del(`rt:s:${topic}`);

    const old = await track(rt.url(topic), {
      'last-event-id': cursorOf(topic, '1000-0'),
    });
    await old.waitFor((f) => f.some((x) => x.event === 'resync'));
    const recent = await track(rt.url(topic), {
      'last-event-id': cursorOf(topic, ids[0]),
    });
    await recent.waitFor((f) => f.some((x) => x.event === 'resync'));
    expect(
      resyncDataSchema.parse(
        JSON.parse(old.frames.find((f) => f.event === 'resync')!.data!).data,
      ),
    ).toEqual({
      reason: 'replay-gap',
    });
  });

  it('S51 AS-18: a cursor at the latest position replays nothing and sends no resync', async () => {
    const topic = `auction:${freshId()}` as const;
    const ids = await publishMany(topic, 3);
    const viewer = await track(rt.url(topic), {
      'last-event-id': cursorOf(topic, ids[2]),
    });
    const next = await rt.publisher.publish(topic, 'price', { n: 4 });
    await viewer.waitFor((f) => f.some((x) => x.event === 'price'));
    expect(viewer.events).toHaveLength(1);
    expect(viewer.events[0].id).toBe(cursorOf(topic, next.id!));
    expect(viewer.frames.some((f) => f.event === 'resync')).toBe(false);
  });

  it('S51 AS-19: a stale or duplicate backplane message is not written', async () => {
    const topic = `auction:${freshId()}` as const;
    const viewer = await track(rt.url(topic));
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) {
      ids.push((await rt.publisher.publish(topic, 'price', { n })).id!);
      await viewer.waitFor(
        (f) => f.filter((x) => x.event === 'price').length === n,
      );
    }
    const craft = (id: string, n: number) =>
      rt.redis.client.publish(
        `rt:c:${topic}`,
        JSON.stringify({ id, topic, type: 'price', data: { n } }),
      );
    await craft(ids[2], 3); // stale
    await craft(ids[4], 5); // the same position again
    const six = await rt.publisher.publish(topic, 'price', { n: 6 });
    await viewer.waitFor(
      (f) => f.filter((x) => x.event === 'price').length === 6,
    );

    expect(numbers(viewer.events)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(viewer.events[5].id).toBe(cursorOf(topic, six.id!));
  });
});
