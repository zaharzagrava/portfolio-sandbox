import { v4 } from 'uuid';
import {
  initialLiveState,
  reduceLive,
  type LiveClientEvent,
  type LiveComment,
  type LivePin,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { inParallel, waitFor } from '@app/test/utils/async-helpers';
import { openSse, type OpenSse } from '@app/test/utils/sse-client';
import {
  createLiveApp,
  expectProblem,
  type Actor,
  type LiveTestApp,
} from './testing/live-test-kit';

describe('Live stream: sampling, batching, snapshots and event connections', () => {
  let t: LiveTestApp;
  const open: OpenSse[] = [];

  beforeAll(async () => {
    t = await createLiveApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());
  afterEach(async () => {
    while (open.length) open.pop()!.close();
    await waitFor(async () => t.registry.size === 0, {
      timeoutMs: 10_000,
      intervalMs: 20,
      description: 'viewers released',
    });
    t.settings.viewerCap = 50_000;
    t.settings.maxBufferedBytes = undefined;
  });

  const connect = async (streamId: string, who: Actor | null = null) => {
    const sse = await t.connect(streamId, who);
    open.push(sse);
    if (sse.status === 200)
      await sse.waitFor((f) => f.some((x) => x.event === 'snapshot'));
    return sse;
  };
  const named = <T = Record<string, unknown>>(
    sse: OpenSse,
    name: string,
  ): T[] =>
    sse.events
      .filter((e) => e.event === name)
      .map((e) => JSON.parse(e.data!) as T);
  type Batch = { items: (LiveComment & { mine?: true })[]; rate: number };
  const batches = (sse: OpenSse) => named<Batch>(sse, 'comments');
  const liveStream = async () => {
    const s = await t.seller();
    return { s, stream: await t.liveStream(s) };
  };
  const manyViewers = async (n: number) => {
    t.stores.limiter.down(); // the per-user budget is AS-20's subject, not the sampler's
    return t.viewers(n);
  };
  const flood = async (
    streamId: string,
    n: number,
    users: Actor[],
    prefix = 'c',
  ) => {
    for (let i = 0; i < n; i += 125) {
      const results = await inParallel(Math.min(125, n - i), (k) =>
        t.comment(streamId, users[(i + k) % users.length], `${prefix}${i + k}`),
      );
      for (const r of results)
        expect(
          (r as PromiseFulfilledResult<{ status: number }>).value.status,
        ).toBe(201);
    }
  };
  const nextBatch = async (sse: OpenSse, seen: number) => {
    t.window();
    await sse.waitFor(
      (f) => f.filter((x) => x.event === 'comments').length > seen,
    );
  };

  // --- AS-01 ------------------------------------------------------------------------------------------------------

  it('S23 AS-01: 1,250 ordinary comments in one window become exactly 5 for each viewer and the batch states rate 5000', async () => {
    const { stream } = await liveStream();
    const users = await manyViewers(25);
    const a = await connect(stream.id);
    const b = await connect(stream.id);
    await flood(stream.id, 1_250, users);
    await t.fed(stream.id, 1_250);
    await nextBatch(a, 0);
    await nextBatch(b, 0);
    expect(batches(a)).toHaveLength(1);
    expect(batches(a)[0].items).toHaveLength(5);
    expect(batches(a)[0].rate).toBe(5_000);
    expect(batches(b)[0].items).toHaveLength(5);
  }, 120_000);

  it('S23 AS-01: a window with 3 ordinary comments delivers all 3 and states rate 12', async () => {
    const { stream } = await liveStream();
    const users = await manyViewers(3);
    const a = await connect(stream.id);
    await flood(stream.id, 3, users);
    await t.fed(stream.id, 3);
    await nextBatch(a, 0);
    expect(batches(a)[0].items).toHaveLength(3);
    expect(batches(a)[0].rate).toBe(12);
  });

  // --- AS-02 ------------------------------------------------------------------------------------------------------

  it('S23 AS-02: 600 comments from 100 users in a second reach a viewer as at most one batch per window of at most 5 sampled comments, never as single events', async () => {
    const { stream } = await liveStream();
    const users = await manyViewers(100);
    const a = await connect(stream.id);
    for (let w = 0; w < 4; w++) {
      await flood(stream.id, 150, users, `w${w}-`);
      await t.fed(stream.id, 150 * (w + 1));
      await nextBatch(a, w);
    }
    const got = batches(a);
    expect(got).toHaveLength(4);
    for (const batch of got) expect(batch.items.length).toBeLessThanOrEqual(5);
    // control events (the once-a-second stats) pass through; a comment is never sent on its own
    expect(a.events.map((e) => e.event)).not.toContain('comment');
  }, 120_000);

  // --- AS-03 ------------------------------------------------------------------------------------------------------

  it('S23 AS-03: staff comments and the viewer’s own comment are in the batch whatever the sample; others never see mine', async () => {
    const { s, stream } = await liveStream();
    const users = await manyViewers(40);
    const me = users[0];
    const stranger = users[1];
    const mine = await connect(stream.id, me);
    const theirs = await connect(stream.id, stranger);
    const staffComments: string[] = [];
    for (let i = 0; i < 3; i++) {
      await t.advance(10_000); // the owner’s own rate budget
      staffComments.push(
        (await t.comment(stream.id, s, `staff ${i}`).expect(201)).body.id,
      );
    }
    await flood(stream.id, 600, users.slice(2));
    const own = (await t.comment(stream.id, me, 'my own words').expect(201))
      .body;
    await t.fed(stream.id, 604);
    await nextBatch(mine, 0);
    await nextBatch(theirs, 0);
    const mineItems = batches(mine)[0].items;
    const theirItems = batches(theirs)[0].items;
    for (const id of staffComments) {
      expect(mineItems.map((i) => i.id)).toContain(id);
      expect(theirItems.map((i) => i.id)).toContain(id);
    }
    const flagged = mineItems.find((i) => i.id === own.id);
    expect(flagged?.mine).toBe(true);
    expect(mineItems.filter((i) => i.mine)).toHaveLength(1);
    expect(theirItems.some((i) => i.mine)).toBe(false);
  }, 120_000);

  it('S23 AS-03: 30 staff comments in one window are all delivered', async () => {
    const { s, stream } = await liveStream();
    const a = await connect(stream.id);
    t.stores.limiter.down();
    for (let i = 0; i < 30; i++)
      await t.comment(stream.id, s, `staff ${i}`).expect(201);
    await t.fed(stream.id, 30);
    await nextBatch(a, 0);
    expect(batches(a)[0].items).toHaveLength(30);
  });

  // --- AS-04 ------------------------------------------------------------------------------------------------------

  it('S23 AS-04: a batch lists each comment once, ascending by id', async () => {
    const { s, stream } = await liveStream();
    const users = await manyViewers(30);
    const a = await connect(stream.id, users[0]);
    await flood(stream.id, 100, users);
    for (let i = 0; i < 5; i++)
      await t.comment(stream.id, s, `staff ${i}`).expect(201);
    await t.fed(stream.id, 105);
    await nextBatch(a, 0);
    const ids = batches(a)[0].items.map((i) => i.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('S23 AS-04: a window with nothing sends no event; 15 seconds without events send a keep-alive line', async () => {
    const { stream } = await liveStream();
    const a = await connect(stream.id);
    t.window();
    // an ordered marker: anything the empty window would have written arrives before this stats frame
    await t.app
      .get(RealtimePublisher)
      .publish(
        `stream:${stream.id}`,
        'stats',
        { second: 1, reactions: {}, viewers: 0 },
        { replay: false },
      );
    await a.waitFor((f) => f.some((x) => x.event === 'stats'));
    expect(batches(a)).toHaveLength(0);
    t.timers.advance(15_000);
    await a.waitFor((f) => f.some((x) => x.comments.includes('ping')));
  });

  // --- AS-05 ------------------------------------------------------------------------------------------------------

  it('S23 AS-05: 1,000 viewers of one stream share one comment-feed subscription, one control subscription and one sampler; the last one leaving releases them within a second', async () => {
    const { stream } = await liveStream();
    t.stores.limiter.down(); // one address opens 1,000 connections: the open limit is AS-12's
    const subscribes = () => t.stores.fast.count('subscribe');
    const before = subscribes();
    const viewers: OpenSse[] = [];
    for (let i = 0; i < 1_000; i += 100)
      viewers.push(
        ...(await Promise.all(
          Array.from({ length: 100 }, () => t.connect(stream.id)),
        )),
      );
    open.push(...viewers);
    expect(viewers.every((v) => v.status === 200)).toBe(true);
    expect(subscribes() - before).toBe(2);
    expect(t.registry.streamsServed()).toEqual([stream.id]);
    expect(t.registry.size).toBe(1_000);
    await t.registry.reportViewers();
    expect(await t.viewerCounts.total(stream.id, t.clock.nowMs())).toBe(1_000);

    while (open.length) open.pop()!.close();
    await waitFor(async () => t.registry.streamsServed().length === 0, {
      timeoutMs: 1_000,
      intervalMs: 20,
      description: 'stream released',
    });
    await waitFor(
      async () =>
        (await t.viewerCounts.total(stream.id, t.clock.nowMs())) === 0,
      { timeoutMs: 1_000, intervalMs: 20, description: 'viewer entry removed' },
    );

    const again = await connect(stream.id);
    expect(again.status).toBe(200);
    expect(subscribes() - before).toBe(4);
    expect(t.registry.streamsServed()).toEqual([stream.id]);
  }, 120_000);

  // --- AS-06 ------------------------------------------------------------------------------------------------------

  it('S23 AS-06: the first event is a snapshot with the status, the pin and the last 50 non-removed comments ascending', async () => {
    const { s, stream } = await liveStream();
    const users = await manyViewers(10);
    const product = await t.product(s.shopId);
    const posted: string[] = [];
    for (let i = 0; i < 120; i++)
      posted.push(
        (
          await t
            .comment(stream.id, users[i % users.length], `comment ${i}`)
            .expect(201)
        ).body.id,
      );
    const removed = posted[117];
    await t.removeComment(s, stream.id, removed).expect(204);
    const pin = (
      await t
        .pin(s, stream.id, { productId: product.id, text: 'Buy now' })
        .expect(200)
    ).body as LivePin;

    const sse = await connect(stream.id);
    expect(sse.status).toBe(200);
    expect(sse.frames.find((f) => f.retry !== undefined)?.retry).toBe(3000);
    const first = sse.events[0];
    expect(first.event).toBe('snapshot');
    const snapshot = JSON.parse(first.data!) as {
      status: string;
      pin: LivePin;
      recent: LiveComment[];
    };
    expect(snapshot.status).toBe('LIVE');
    expect(snapshot.pin).toEqual(pin);
    const expected = posted.filter((id) => id !== removed).slice(-50);
    expect(snapshot.recent.map((c) => c.id)).toEqual(expected);
  }, 120_000);

  it('S23 AS-06: a stream without comments gives recent [] and pin null', async () => {
    const { stream } = await liveStream();
    const sse = await connect(stream.id);
    expect(JSON.parse(sse.events[0].data!)).toMatchObject({
      status: 'LIVE',
      pin: null,
      recent: [],
    });
  });

  // --- AS-07 ------------------------------------------------------------------------------------------------------

  it('S23 AS-07: viewers connecting while staff change the pin and remove comments end on the server’s pin and visible comments, 20 times', async () => {
    const s = await t.seller();
    const users = await manyViewers(20);
    const product = await t.product(s.shopId);
    // the rounds use streams of their own, so five of them run at the same time
    const oneRound = async (round: number) => {
      const stream = await t.liveStream(s);
      const ids: string[] = [];
      for (let i = 0; i < 6; i++)
        ids.push(
          (await t.comment(stream.id, users[i], `c${i}`).expect(201)).body.id,
        );
      const changes = (async () => {
        for (let i = 0; i < 3; i++) {
          await t
            .pin(s, stream.id, {
              productId: product.id,
              text: `pin ${round}.${i}`,
            })
            .expect(200);
          await t.removeComment(s, stream.id, ids[i]).expect(204);
        }
        await t.unpin(s, stream.id).expect(204);
        await t
          .pin(s, stream.id, { productId: product.id, text: `final ${round}` })
          .expect(200);
      })();
      const sse = await t.connect(stream.id);
      open.push(sse);
      await changes;
      const [row] = await t.rows<{ pin: { text: string }; pinVersion: number }>(
        `SELECT pin, "pinVersion" FROM "LiveStream" WHERE id = :id`,
        { id: stream.id },
      );
      // What the client shows after applying the snapshot and every later event, as the client reducer does.
      const reduced = () =>
        sse.events.reduce(
          (acc, e) =>
            reduceLive(acc, {
              type: e.event,
              data: JSON.parse(e.data!),
            } as LiveClientEvent),
          initialLiveState(),
        );
      // Events still on their way: wait for the state to settle, then compare it with the server (a state that never
      // reaches the server's fails the comparison below with the difference).
      await waitFor(
        () =>
          Promise.resolve(
            reduced().pinVersion === row.pinVersion &&
              reduced().comments.length === ids.length - 3,
          ),
        {
          timeoutMs: 5_000,
          intervalMs: 20,
          description: 'client state settled',
        },
      ).catch(() => undefined);
      const final = reduced();
      expect(final.pin?.text).toBe(row.pin.text);
      expect(final.pinVersion).toBe(row.pinVersion);
      expect(final.comments.map((c) => c.id)).toEqual(ids.slice(3));
      sse.close();
      open.splice(open.indexOf(sse), 1);
    };
    for (let from = 0; from < 20; from += 5)
      await Promise.all(
        Array.from({ length: 5 }, (_, k) => oneRound(from + k)),
      );
  }, 180_000);

  // --- AS-08 ------------------------------------------------------------------------------------------------------

  it('S23 AS-08: pin, comment_removed, status and stats reach connected viewers within 250 ms, unsampled', async () => {
    const { s, stream } = await liveStream();
    const product = await t.product(s.shopId);
    const poster = await t.viewer();
    const comment = (
      await t.comment(stream.id, poster, 'to be removed').expect(201)
    ).body;
    const a = await connect(stream.id);
    const within = async (act: () => Promise<unknown>, event: string) => {
      const start = Date.now();
      await act();
      await a.waitFor((f) => f.some((x) => x.event === event), 250);
      expect(Date.now() - start).toBeLessThanOrEqual(250);
    };
    await within(
      () =>
        t.pin(s, stream.id, { productId: product.id, text: 'Buy' }).expect(200),
      'pin',
    );
    await within(
      () => t.removeComment(s, stream.id, comment.id).expect(204),
      'comment_removed',
    );
    await t.advance(1_000);
    await within(() => t.ticker.tick(), 'stats');
    await within(() => t.end(s, stream.id).expect(200), 'status');
    expect(batches(a)).toHaveLength(0);
  });

  // --- AS-10 ------------------------------------------------------------------------------------------------------

  it('S23 AS-10: a viewer that stopped reading and buffers more than 256 KB is closed and counted; others are unaffected; a reconnect starts from a snapshot', async () => {
    const { stream } = await liveStream();
    const slow = await connect(stream.id);
    const healthy = await connect(stream.id);
    slow.pause();
    const before =
      MetricsRegistry.value('live_viewers_dropped_total', { reason: 'slow' }) ??
      0;
    const text = '😀'.repeat(200);
    const author = v4();
    let windows = 0;
    await waitFor(
      async () => {
        for (let i = 0; i < 100; i++)
          await t.feed.publish({
            id: `00000000-0000-7000-8000-${String(windows * 100 + i + 1).padStart(12, '0')}`,
            streamId: stream.id,
            authorId: author,
            authorName: 'viewer-aaaaaaaa',
            text,
            at: t.clock.nowMs(),
            priority: true,
          });
        windows++;
        await t.fed(stream.id, windows * 100);
        t.window();
        return (
          (MetricsRegistry.value('live_viewers_dropped_total', {
            reason: 'slow',
          }) ?? 0) > before
        );
      },
      { timeoutMs: 60_000, intervalMs: 0, description: 'slow viewer dropped' },
    );
    expect(t.registry.size).toBe(1);
    expect(batches(healthy).length).toBeGreaterThan(0);
    const again = await connect(stream.id);
    const snapshot = JSON.parse(again.events[0].data!) as { recent: unknown[] };
    expect(snapshot.recent).toEqual([]); // the feed is not the recent list: nothing is replayed
  }, 120_000);

  // --- AS-11 ------------------------------------------------------------------------------------------------------

  it('S23 AS-11: at the instance’s viewer cap the next connection is 503 gateway_full with Retry-After 5 and creates no subscription', async () => {
    const { stream } = await liveStream();
    const { stream: other } = await liveStream();
    t.settings.viewerCap = 3;
    const three = [
      await connect(stream.id),
      await connect(stream.id),
      await connect(stream.id),
    ];
    const subscribes = t.stores.fast.count('subscribe');
    const refused = await t.connect(other.id);
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('5');
    expect(expectProblem(refused.body).code).toBe('gateway_full');
    expect(t.stores.fast.count('subscribe')).toBe(subscribes);
    expect(t.registry.streamsServed()).toEqual([stream.id]);
    expect(three.every((c) => !c.ended)).toBe(true);
  });

  // --- AS-12 ------------------------------------------------------------------------------------------------------

  it('S23 AS-12: unknown 404, malformed 400, ended 409', async () => {
    const { s } = await liveStream();
    const ended = await t.liveStream(s);
    await t.end(s, ended.id).expect(200);
    const unknown = await t.connect(v4());
    expect(unknown.status).toBe(404);
    expect(expectProblem(unknown.body).code).toBe('stream_not_found');
    expect((await t.connect('nope')).status).toBe(400);
    const gone = await t.connect(ended.id);
    expect(gone.status).toBe(409);
    expect(expectProblem(gone.body).code).toBe('stream_ended');
  });

  it('S23 AS-12: a scheduled stream opens with its status and gets status LIVE at the start; the end sends status ENDED and closes within a second', async () => {
    const s = await t.seller();
    const stream = await t.createStream(s);
    const sse = await connect(stream.id);
    expect(JSON.parse(sse.events[0].data!).status).toBe('SCHEDULED');
    await t.start(s, stream.id).expect(200);
    await sse.waitFor((f) =>
      f.some((x) => x.event === 'status' && x.data === '{"status":"LIVE"}'),
    );
    await t.end(s, stream.id).expect(200);
    await sse.waitFor((f) =>
      f.some((x) => x.event === 'status' && x.data === '{"status":"ENDED"}'),
    );
    await sse.waitForEnd(1_000);
    await waitFor(async () => t.registry.streamsServed().length === 0, {
      timeoutMs: 1_000,
      intervalMs: 20,
      description: 'stream released',
    });
  });

  // --- AS-13 ------------------------------------------------------------------------------------------------------

  it('S23 AS-13: the comment feed topic and an unregistered prefix are refused like any unknown topic; the public control topic never carries a comment', async () => {
    const { stream } = await liveStream();
    const url = (topic: string) =>
      `${t.baseUrl}/streams?topics=${encodeURIComponent(topic)}`;
    const feed = await openSse(url(`livefeed:${stream.id}`));
    const unknown = await openSse(url(`nonsense:${stream.id}`));
    expect(feed.status).toBe(400);
    expect(feed.body.code).toBe('invalid_topics');
    expect(unknown.status).toBe(feed.status);
    expect(unknown.body.code).toBe(feed.body.code);

    const watcher = await openSse(url(`stream:${stream.id}`));
    open.push(watcher);
    expect(watcher.status).toBe(200);
    const poster = await t.viewer();
    await t.comment(stream.id, poster, 'secret chatter').expect(201);
    await t.app
      .get(RealtimePublisher)
      .publish(
        `stream:${stream.id}`,
        'stats',
        { second: 7, reactions: {}, viewers: 1 },
        { replay: false },
      );
    await watcher.waitFor((f) => f.some((x) => x.event === 'stats'));
    expect(watcher.events.map((e) => e.event)).not.toContain('comment');
    expect(JSON.stringify(watcher.frames.map((f) => f.raw))).not.toContain(
      'secret chatter',
    );
  });
});
