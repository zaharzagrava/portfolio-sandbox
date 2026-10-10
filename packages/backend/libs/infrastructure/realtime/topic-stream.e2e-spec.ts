import {
  problemDetailsSchema,
  streamEventEnvelopeSchema,
} from '@marketplace-sandbox/contracts';
import { openSse, readSse, type OpenSse } from '@app/test/utils/sse-client';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
import { waitFor } from '@app/test/utils/async-helpers';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/** S51 US1 (AS-01 to AS-06): the stream delivers events, hostile input is safe. Real Redis, real Nest app. */
describe('S51 topic stream (STREAM)', () => {
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
    // every closed viewer releases its backplane subscription
    await waitFor(
      async () => rt.hub.channelCount() === 0 && rt.hub.listenerCount() === 0,
      {
        timeoutMs: 5_000,
        intervalMs: 25,
      },
    );
  });

  const dataOf = (frame: { data?: string }) =>
    streamEventEnvelopeSchema.parse(JSON.parse(frame.data!));

  it('S51 AS-01: delivers a live event with the contract headers, retry first, and no compression', async () => {
    const topic = `auction:${freshId()}` as const;
    const stream = await track(rt.url(topic), { 'accept-encoding': 'gzip' });
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toBe(
      'text/event-stream; charset=utf-8',
    );
    expect(stream.headers['cache-control']).toBe('no-cache, no-transform');
    expect(stream.headers['x-accel-buffering']).toBe('no');
    expect(stream.headers['content-encoding']).toBeUndefined();

    const { published, id } = await rt.publisher.publish(topic, 'price', {
      price: 7,
    });
    expect(published).toBe(true);
    await stream.waitFor((frames) => frames.some((f) => f.event === 'price'));

    expect(stream.frames[0].retry).toBeGreaterThanOrEqual(2000);
    expect(stream.frames[0].retry).toBeLessThanOrEqual(5000);
    const event = stream.events[0];
    expect(event.event).toBe('price');
    expect(event.id).toBe(`${topic}~${id}`);
    expect(dataOf(event)).toEqual({ topic, data: { price: 7 } });
    // stored state: the event is in the replay buffer under the lib's own key prefix
    expect(await rt.redis.client.xlen(`rt:s:${topic}`)).toBe(1);
  });

  it('S51 AS-02: two topics on one connection share one combined cursor', async () => {
    const a1 = `auction:${freshId()}` as const;
    const a2 = `auction:${freshId()}` as const;
    const stream = await track(rt.url(a1, a2));
    const first = await rt.publisher.publish(a1, 'price', { n: 1 });
    await stream.waitFor((f) => f.some((x) => x.event === 'price'));
    const second = await rt.publisher.publish(a2, 'price', { n: 2 });
    await stream.waitFor(
      (f) => f.filter((x) => x.event === 'price').length === 2,
    );

    expect(stream.events[0].id).toBe(`${a1}~${first.id}`);
    expect(stream.events[1].id).toBe(`${a1}~${first.id}|${a2}~${second.id}`);
  });

  it("S51 AS-03: viewers of different topics do not see each other's events", async () => {
    const a = `auction:${freshId()}` as const;
    const b = `auction:${freshId()}` as const;
    const viewerA = await track(rt.url(a));
    const viewerB = await track(rt.url(b));
    await rt.publisher.publish(a, 'price', { for: 'a' });
    await rt.publisher.publish(b, 'price', { for: 'b' });
    await viewerA.waitFor((f) => f.some((x) => x.event === 'price'));
    await viewerB.waitFor((f) => f.some((x) => x.event === 'price'));
    // a barrier event per topic proves nothing else arrived after the first
    await rt.publisher.publish(a, 'done', {});
    await rt.publisher.publish(b, 'done', {});
    await viewerA.waitFor((f) => f.some((x) => x.event === 'done'));
    await viewerB.waitFor((f) => f.some((x) => x.event === 'done'));

    expect(viewerA.events.map((e) => dataOf(e).topic)).toEqual([a, a]);
    expect(viewerB.events.map((e) => dataOf(e).topic)).toEqual([b, b]);
  });

  const tooMany = Array.from({ length: 11 }, (_, i) => `auction:t${i}`).join(
    ',',
  );
  const requests: Array<[string, string, string]> = [
    ['topics missing', 'streams', 'invalid_topics'],
    ['topics empty', 'streams?topics=', 'invalid_topics'],
    ['11 distinct topics', `streams?topics=${tooMany}`, 'invalid_topics'],
    ['an empty id', 'streams?topics=user:', 'invalid_topics'],
    ['an upper-case prefix', 'streams?topics=USER:abc', 'invalid_topics'],
    ['too many segments', 'streams?topics=auction:a1:x:y', 'invalid_topics'],
    [
      'an id of 65 characters',
      `streams?topics=auction:${'a'.repeat(65)}`,
      'invalid_topics',
    ],
    ['an illegal character', 'streams?topics=auction:a.1', 'invalid_topics'],
    ['a prefix nobody defined', 'streams?topics=nosuch:1', 'invalid_topics'],
    ['a singleton with an id', 'streams?topics=flags:x', 'invalid_topics'],
    // The harness defines shop+assets, so a suffix no route lists stands for "no route shop+assets is defined".
    [
      'a suffix no route defines',
      'streams?topics=shop:s1:seatmap',
      'invalid_topics',
    ],
    [
      'an access_token in the URL',
      'streams?topics=auction:a1&access_token=abc',
      'invalid_query',
    ],
    [
      'a ticket in the URL',
      'streams?topics=auction:a1&ticket=abc',
      'invalid_query',
    ],
  ];

  it.each(requests)(
    'S51 AS-04: %s is refused with 400 and creates no subscription',
    async (_label, path, code) => {
      const res = await readSse(`${rt.baseUrl}/${path}`, {
        count: 1,
        timeoutMs: 3_000,
      });
      expect(res.status).toBe(400);
      const problem = problemDetailsSchema.parse(res.body);
      expect(problem.code).toBe(code);
      expect(problem.status).toBe(400);
      expect(rt.hub.channelCount()).toBe(0);
      expect(rt.hub.listenerCount()).toBe(0);
    },
  );

  it('S51 AS-04: the backplane shows zero subscribers for a refused topic', async () => {
    const id = freshId();
    const res = await readSse(
      `${rt.baseUrl}/streams?topics=auction:${id}&access_token=abc`,
      { count: 1, timeoutMs: 3_000 },
    );
    expect(res.status).toBe(400);
    const [, subscribers] = (await rt.redis.client.pubsub(
      'NUMSUB',
      `rt:c:auction:${id}`,
    )) as [string, number];
    expect(Number(subscribers)).toBe(0);
  });

  it('S51 AS-05: duplicate topics collapse into one subscription and one delivery', async () => {
    const topic = `auction:${freshId()}` as const;
    const stream = await track(rt.url(topic, topic, ` ${topic}`));
    expect(rt.hub.listenerCount()).toBe(1);
    await rt.publisher.publish(topic, 'price', { n: 1 });
    await stream.waitFor((f) => f.some((x) => x.event === 'price'));
    await rt.publisher.publish(topic, 'done', {});
    await stream.waitFor((f) => f.some((x) => x.event === 'done'));
    expect(stream.events.map((e) => e.event)).toEqual(['price', 'done']);
  });

  it('S51 AS-06: a hostile payload cannot inject fields or frames end to end', async () => {
    const topic = `stream:${freshId()}` as const;
    const stream = await track(rt.url(topic));
    const ls = String.fromCharCode(0x2028);
    const text = `a\n\nevent: evil\ndata: {"topic":"x"}\nid: auction:a1~1-1\r\nretry: 1${ls}tail`;
    await rt.publisher.publish(topic, 'comment', { text });
    await stream.waitFor((f) => f.some((x) => x.event === 'comment'));
    await rt.publisher.publish(topic, 'done', {});
    await stream.waitFor((f) => f.some((x) => x.event === 'done'));

    const events = stream.events;
    expect(events.map((e) => e.event)).toEqual(['comment', 'done']);
    expect(dataOf(events[0]).data).toEqual({ text });
    expect(stream.frames.filter((f) => f.retry !== undefined)).toHaveLength(1);
    expect(stream.frames.some((f) => f.event === 'evil')).toBe(false);
  });

  it('S51 AS-01: a delivered event is counted', async () => {
    const topic = `auction:${freshId()}` as const;
    const before =
      MetricsRegistry.value('realtime_events_delivered_total', {
        kind: 'replayable',
      }) ?? 0;
    const stream = await track(rt.url(topic));
    await rt.publisher.publish(topic, 'price', {});
    await stream.waitFor((f) => f.some((x) => x.event === 'price'));
    await waitFor(
      async () =>
        (MetricsRegistry.value('realtime_events_delivered_total', {
          kind: 'replayable',
        }) ?? 0) > before,
      { timeoutMs: 5_000, intervalMs: 25 },
    );
  });
});
