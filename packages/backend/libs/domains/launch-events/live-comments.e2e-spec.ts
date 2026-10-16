import { v4 } from 'uuid';
import {
  liveCommentSchema,
  liveSnapshotSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { inParallel } from '@app/test/utils/async-helpers';
import { minuteBucket } from './domain/live-history-keys';
import {
  createLiveApp,
  expectContract,
  expectProblem,
  type Actor,
  type LiveTestApp,
} from './testing/live-test-kit';

describe('Live stream: comment ingest, moderation and mutes', () => {
  let t: LiveTestApp;
  let redis: RedisService;

  beforeAll(async () => {
    t = await createLiveApp();
    redis = t.app.get(RedisService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const posted = () => t.sent.filter((e) => e.type === 'live.comment_posted');
  const recent = async (streamId: string) =>
    expectContract(
      liveSnapshotSchema,
      (await t.snapshot(streamId).expect(200)).body,
    ).recent;
  const fedTo = (streamId: string) =>
    t.registry.batcher(streamId)?.received ?? 0;
  const nothingHappened = async (streamId: string) => {
    expect(posted()).toHaveLength(0);
    expect(await recent(streamId)).toHaveLength(0);
  };
  const wipeFastStore = async () => {
    const keys = await redis.client.keys('live:*');
    if (keys.length > 0) await redis.client.del(...keys);
  };

  async function liveStreamWithSeller() {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    return { s, stream };
  }

  // --- AS-15 ------------------------------------------------------------------------------------------------------

  it('S23 AS-15: an accepted comment is 201 with the contract document, a time-ordered id and the server time', async () => {
    const { stream } = await liveStreamWithSeller();
    const viewer = await t.viewer();
    const before = t.clock.nowMs();
    const first = expectContract(
      liveCommentSchema,
      (await t.comment(stream.id, viewer, 'Take my money!').expect(201)).body,
    );
    await t.advance(5);
    const other = await t.viewer();
    const second = expectContract(
      liveCommentSchema,
      (await t.comment(stream.id, other, 'Me too').expect(201)).body,
    );
    expect(first).toMatchObject({
      streamId: stream.id,
      authorId: viewer.id,
      text: 'Take my money!',
    });
    expect(first.priority).toBeUndefined();
    expect(first.at).toBe(before);
    expect(first.id < second.id).toBe(true);
    expect((await recent(stream.id)).map((c) => c.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(posted()).toHaveLength(2);
    expect(posted()[0].payload).toMatchObject({
      streamId: stream.id,
      commentId: first.id,
      authorId: viewer.id,
      text: 'Take my money!',
      at: first.at,
    });
  });

  it('S23 AS-15: the comment reaches the stream’s viewers in the next window', async () => {
    const { stream } = await liveStreamWithSeller();
    const watcher = await t.connect(stream.id);
    await watcher.waitFor((f) => f.some((e) => e.event === 'snapshot'));
    const viewer = await t.viewer();
    const c = expectContract(
      liveCommentSchema,
      (await t.comment(stream.id, viewer, 'Hello viewers').expect(201)).body,
    );
    await t.fed(stream.id, 1);
    t.window();
    await watcher.waitFor((f) => f.some((e) => e.event === 'comments'));
    const batch = JSON.parse(
      watcher.events.find((e) => e.event === 'comments')!.data!,
    ) as { items: { id: string }[] };
    expect(batch.items.map((i) => i.id)).toEqual([c.id]);
    watcher.close();
  });

  it('S23 AS-15: a comment on a warm stream makes no relational query', async () => {
    const { stream } = await liveStreamWithSeller();
    const viewer = await t.viewer();
    await t.comment(stream.id, viewer, 'warm up').expect(201);
    await t.advance(11_000);
    t.queries.count = 0;
    await t.comment(stream.id, viewer, 'cold? no').expect(201);
    expect(t.queries.sql).toEqual([]);
  });

  // --- AS-16 ------------------------------------------------------------------------------------------------------

  it('S23 AS-16: OWNER, ADMIN and STAFF of the owning shop post with priority; a read-only member, another shop’s owner and a non-member do not', async () => {
    const { s, stream } = await liveStreamWithSeller();
    const admin = await t.member(s.shopId, 'ADMIN');
    const staffer = await t.member(s.shopId, 'STAFF');
    const reader = await t.member(s.shopId, 'VIEWER');
    const rival = await t.seller();
    const nobody = await t.viewer();
    const priority = async (who: Actor) =>
      expectContract(
        liveCommentSchema,
        (
          await t
            .comment(stream.id, who, `from ${who.id.slice(0, 4)}`)
            .expect(201)
        ).body,
      ).priority;
    expect(await priority(s)).toBe(true);
    expect(await priority(admin)).toBe(true);
    expect(await priority(staffer)).toBe(true);
    expect(await priority(reader)).toBeUndefined();
    expect(await priority(rival)).toBeUndefined();
    expect(await priority(nobody)).toBeUndefined();
    expect(posted().filter((e) => e.payload.priority === true)).toHaveLength(3);
  });

  // --- AS-17 ------------------------------------------------------------------------------------------------------

  it.each([
    ['text missing', {}],
    ['text not a string', { text: 42 }],
    ['text empty', { text: '' }],
    ['text blank after trimming', { text: ' \t\n  ' }],
    ['text of only zero-width characters', { text: '​‌' }],
    ['text over 200 code points', { text: 'a'.repeat(201) }],
    ['text over 200 code points as emoji', { text: '😀'.repeat(201) }],
    ['unknown extra property', { text: 'hi', color: 'red' }],
    ['clientId not a UUID', { text: 'hi', clientId: 'abc' }],
  ])(
    'S23 AS-17: %s is 422 with errors[] and nothing is published or stored',
    async (_name, body) => {
      const { stream } = await liveStreamWithSeller();
      const viewer = await t.viewer();
      const res = await t.comment(stream.id, viewer, body).expect(422);
      expect(expectProblem(res.body).errors?.length).toBeGreaterThan(0);
      await nothingHappened(stream.id);
    },
  );

  it('S23 AS-17: exactly 200 code points (emoji counted as their code points) are accepted and stored normalized', async () => {
    const { stream } = await liveStreamWithSeller();
    const viewer = await t.viewer();
    const twoHundred = '👨‍👩‍👧'.repeat(40); // 5 code points each
    const ok = await t.comment(stream.id, viewer, twoHundred).expect(201);
    expect(ok.body.text).toBe(twoHundred);
    const messy = await t
      .comment(stream.id, await t.viewer(), 'a ​  b\u0007\n c  ')
      .expect(201);
    expect(messy.body.text).toBe('a b c');
    expect(posted()[1].payload.text).toBe('a b c');
  });

  it('S23 AS-17: a malformed stream id is 400', async () => {
    const viewer = await t.viewer();
    await t.comment('nope', viewer, 'hi').expect(400);
  });

  // --- AS-18 ------------------------------------------------------------------------------------------------------

  it('S23 AS-18: no credentials is 401; an unknown stream 404 stream_not_found; a SCHEDULED or ENDED stream 409 stream_not_live; nothing is published', async () => {
    const s = await t.seller();
    const viewer = await t.viewer();
    const scheduled = await t.createStream(s);
    const ended = await t.liveStream(s);
    await t.end(s, ended.id).expect(200);
    await t.comment(scheduled.id, null, 'hi').expect(401);
    const unknown = await t.comment(v4(), viewer, 'hi').expect(404);
    expect(expectProblem(unknown.body).code).toBe('stream_not_found');
    for (const id of [scheduled.id, ended.id]) {
      const res = await t.comment(id, viewer, 'hi').expect(409);
      expect(expectProblem(res.body).code).toBe('stream_not_live');
    }
    expect(posted()).toHaveLength(0);
    expect(await recent(ended.id)).toHaveLength(0);
  });

  // --- AS-19 ------------------------------------------------------------------------------------------------------

  it.each([
    ['visit http://x.io', 'link'],
    ['www.x.io', 'link'],
    ['scam', 'policy'],
    ['SCAMS!!', 'policy'],
    ['sc4m', 'policy'],
    ['s c a m', 'policy'],
    ['scaaaam', 'policy'],
    ['scám', 'policy'],
    ['free iphone', 'policy'],
    ['click here', 'policy'],
  ])(
    'S23 AS-19: "%s" is 422 comment_blocked with reason %s, never the list, and nothing is published',
    async (text, reason) => {
      const { stream } = await liveStreamWithSeller();
      const res = await t
        .comment(stream.id, await t.viewer(), text)
        .expect(422);
      const problem = expectProblem(res.body);
      expect(problem.code).toBe('comment_blocked');
      expect(problem.reason).toBe(reason);
      expect(JSON.stringify(res.body)).not.toMatch(/scam|iphone|banned/i);
      await nothingHappened(stream.id);
    },
  );

  it.each([['fa keyboard'], ['scampi pasta'], ['I love it']])(
    'S23 AS-19: "%s" is accepted',
    async (text) => {
      const { stream } = await liveStreamWithSeller();
      await t.comment(stream.id, await t.viewer(), text).expect(201);
    },
  );

  it('S23 AS-19: a blocked attempt still uses the rate budget', async () => {
    const { stream } = await liveStreamWithSeller();
    const viewer = await t.viewer();
    for (let i = 0; i < 3; i++)
      await t.comment(stream.id, viewer, 'scam').expect(422);
    await t.comment(stream.id, viewer, 'a fine comment').expect(429);
  });

  // --- AS-20 ------------------------------------------------------------------------------------------------------

  it('S23 AS-20: the 4th comment inside 10 seconds is 429 with Retry-After and is not published; another user is unaffected', async () => {
    const { stream } = await liveStreamWithSeller();
    const viewer = await t.viewer();
    for (let i = 0; i < 3; i++)
      await t.comment(stream.id, viewer, `c${i}`).expect(201);
    const limited = await t
      .comment(stream.id, viewer, 'one too many')
      .expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(posted()).toHaveLength(3);
    await t.comment(stream.id, await t.viewer(), 'fine').expect(201);
    await t.advance(10_000);
    await t.comment(stream.id, viewer, 'again').expect(201);
  });

  it('S23 AS-20: a limiter that is down lets comments through (fail open) and the outage is counted', async () => {
    const { stream } = await liveStreamWithSeller();
    const viewer = await t.viewer();
    const before =
      MetricsRegistry.value('live_limiter_unavailable_total', {
        policy: 'live.comment',
      }) ?? 0;
    t.stores.limiter.down();
    for (let i = 0; i < 5; i++)
      await t.comment(stream.id, viewer, `c${i}`).expect(201);
    expect(
      MetricsRegistry.value('live_limiter_unavailable_total', {
        policy: 'live.comment',
      }),
    ).toBeGreaterThanOrEqual(before + 5);
  });

  // --- AS-21 ------------------------------------------------------------------------------------------------------

  it('S23 AS-21: a muted viewer is 403 user_muted in that stream only, nothing published; unmuting restores posting; earlier comments stay', async () => {
    const { s, stream } = await liveStreamWithSeller();
    const other = await t.liveStream(s);
    const viewer = await t.viewer();
    const earlier = await t
      .comment(stream.id, viewer, 'before the mute')
      .expect(201);
    await t.mute(s, stream.id, viewer.id).expect(204);
    await t.advance(10_000);
    const muted = await t
      .comment(stream.id, viewer, 'after the mute')
      .expect(403);
    expect(expectProblem(muted.body).code).toBe('user_muted');
    expect(posted()).toHaveLength(1);
    await t.comment(other.id, viewer, 'elsewhere').expect(201);
    await t.unmute(s, stream.id, viewer.id).expect(204);
    await t.comment(stream.id, viewer, 'free again').expect(201);
    expect((await recent(stream.id)).map((c) => c.id)).toContain(
      earlier.body.id,
    );
  });

  it('S23 AS-21: a wipe of the fast store after the mute does not lift it (the mute is durable)', async () => {
    const { s, stream } = await liveStreamWithSeller();
    const viewer = await t.viewer();
    await t.mute(s, stream.id, viewer.id).expect(204);
    await wipeFastStore();
    const res = await t.comment(stream.id, viewer, 'sneaking back').expect(403);
    expect(expectProblem(res.body).code).toBe('user_muted');
  });

  // --- AS-22 ------------------------------------------------------------------------------------------------------

  it('S23 AS-22: a retry with the same clientId and text returns the original (200, same id and time), with no second delivery or event', async () => {
    const { stream } = await liveStreamWithSeller();
    const viewer = await t.viewer();
    const clientId = v4();
    const first = await t
      .comment(stream.id, viewer, { text: 'once', clientId })
      .expect(201);
    await t.advance(5_000);
    const retry = await t
      .comment(stream.id, viewer, { text: 'once', clientId })
      .expect(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.at).toBe(first.body.at);
    expect(posted()).toHaveLength(1);
    expect(await recent(stream.id)).toHaveLength(1);
  });

  it('S23 AS-22: the same clientId with different text is 422 client_id_reused; another user using it is independent', async () => {
    const { stream } = await liveStreamWithSeller();
    const viewer = await t.viewer();
    const clientId = v4();
    await t.comment(stream.id, viewer, { text: 'one', clientId }).expect(201);
    const reused = await t
      .comment(stream.id, viewer, { text: 'two', clientId })
      .expect(422);
    expect(expectProblem(reused.body).code).toBe('client_id_reused');
    await t
      .comment(stream.id, await t.viewer(), { text: 'two', clientId })
      .expect(201);
    expect(posted()).toHaveLength(2);
  });

  it('S23 AS-22: 20 simultaneous posts with one clientId make exactly one 201, nineteen 200 with the same id and one event, 20 times over', async () => {
    const { stream } = await liveStreamWithSeller();
    t.stores.limiter.down(); // the budget is not the subject here: twenty posts of one user at once
    for (let round = 0; round < 20; round++) {
      const viewer = await t.viewer();
      const clientId = v4();
      t.sent.length = 0;
      const results = await inParallel(20, () =>
        t.comment(stream.id, viewer, { text: `round ${round}`, clientId }),
      );
      const values = results.map(
        (r) =>
          (
            r as PromiseFulfilledResult<{
              status: number;
              body: { id: string };
            }>
          ).value,
      );
      expect(values.filter((v) => v.status === 201)).toHaveLength(1);
      expect(values.filter((v) => v.status === 200)).toHaveLength(19);
      expect(new Set(values.map((v) => v.body.id)).size).toBe(1);
      expect(posted()).toHaveLength(1);
    }
  });

  // --- AS-23 ------------------------------------------------------------------------------------------------------

  it('S23 AS-23: an event stream that refuses writes gives 503 live_unavailable and nothing visible; the retry with the clientId makes one comment and one event', async () => {
    const { stream } = await liveStreamWithSeller();
    const viewer = await t.viewer();
    const clientId = v4();
    t.stores.events.down();
    const failed = await t
      .comment(stream.id, viewer, { text: 'hello', clientId })
      .expect(503);
    const problem = expectProblem(failed.body);
    expect(problem.code).toBe('live_unavailable');
    expect(problem.detail).not.toMatch(/events is down/);
    expect(await recent(stream.id)).toHaveLength(0);
    expect(fedTo(stream.id)).toBe(0);
    t.stores.events.up();
    t.sent.length = 0;
    await t.advance(10_000);
    const retry = await t
      .comment(stream.id, viewer, { text: 'hello', clientId })
      .expect(201);
    expect(posted()).toHaveLength(1);
    expect((await recent(stream.id)).map((c) => c.id)).toEqual([retry.body.id]);
  });

  it('S23 AS-23: a recent list that refuses writes after the event was accepted gives 503; the retry makes the comment visible without a second event', async () => {
    const { stream } = await liveStreamWithSeller();
    const viewer = await t.viewer();
    const clientId = v4();
    t.stores.fast.failing.add('add');
    const failed = await t
      .comment(stream.id, viewer, { text: 'hello', clientId })
      .expect(503);
    expect(expectProblem(failed.body).code).toBe('live_unavailable');
    expect(posted()).toHaveLength(1);
    t.stores.fast.failing.clear();
    await t.advance(10_000);
    const retry = await t
      .comment(stream.id, viewer, { text: 'hello', clientId })
      .expect(200);
    expect(posted()).toHaveLength(1);
    expect((await recent(stream.id)).map((c) => c.id)).toEqual([retry.body.id]);
    expect(retry.body.id).toBe(posted()[0].payload.commentId);
  });

  // --- AS-24 ------------------------------------------------------------------------------------------------------

  it('S23 AS-24: 1,000 comments from 30 concurrent posters on a warm stream make zero relational queries', async () => {
    const { stream } = await liveStreamWithSeller();
    const posters = await t.viewers(30);
    t.stores.limiter.down();
    for (const p of posters)
      await t.comment(stream.id, p, 'warm up').expect(201);
    t.queries.count = 0;
    let done = 0;
    const worker = async (p: Actor) => {
      for (let i = 0; i < 34 && done < 1_000; i++) {
        done++;
        const res = await t.comment(stream.id, p, `comment ${i}`);
        expect(res.status).toBe(201);
      }
    };
    await Promise.all(posters.map(worker));
    expect(done).toBe(1_000);
    expect(t.queries.count).toBe(0);
  }, 120_000);

  it('S23 AS-24: with the stream state evicted, 100 concurrent comments cause exactly one relational read', async () => {
    const { stream } = await liveStreamWithSeller();
    const posters = await t.viewers(10);
    t.stores.limiter.down();
    for (const p of posters)
      await t.comment(stream.id, p, 'warm up').expect(201);
    await t.state.evict(stream.id);
    t.queries.count = 0;
    const results = await inParallel(100, (i) =>
      t.comment(stream.id, posters[i % posters.length], `cold ${i}`),
    );
    for (const r of results)
      expect(
        (r as PromiseFulfilledResult<{ status: number }>).value.status,
      ).toBe(201);
    expect(t.queries.count).toBe(1);
  });

  it('S23 AS-24: 1,000 posts to 1,000 unknown stream ids are 404 with at most one read per id, and the unknown answer is cached for 10 seconds', async () => {
    const posters = await t.viewers(20);
    t.stores.limiter.down();
    const ids = Array.from({ length: 1_000 }, () => v4());
    await t.comment(ids[0], posters[0], 'warm the role cache').expect(404);
    t.queries.count = 0;
    const results = await inParallel(1_000, (i) =>
      t.comment(ids[i], posters[i % posters.length], 'anyone?'),
    );
    for (const r of results)
      expect(
        (r as PromiseFulfilledResult<{ status: number }>).value.status,
      ).toBe(404);
    expect(t.queries.count).toBeLessThanOrEqual(1_000);
    t.queries.count = 0;
    for (let i = 0; i < 50; i++)
      await t.comment(ids[i], posters[0], 'again').expect(404);
    expect(t.queries.count).toBe(0);
  }, 120_000);

  // --- AS-25 ------------------------------------------------------------------------------------------------------

  it('S23 AS-25: the author name is a stable handle per (user, stream), differs across streams, and no e-mail appears in any payload', async () => {
    const { s, stream } = await liveStreamWithSeller();
    const other = await t.liveStream(s);
    const viewer = await t.viewer();
    const first = await t.comment(stream.id, viewer, 'hello').expect(201);
    await t.advance(10_000);
    const second = await t.comment(stream.id, viewer, 'again').expect(201);
    const elsewhere = await t.comment(other.id, viewer, 'hello').expect(201);
    expect(first.body.authorName).toMatch(/^viewer-[a-z]{8}$/);
    expect(second.body.authorName).toBe(first.body.authorName);
    expect(elsewhere.body.authorName).not.toBe(first.body.authorName);

    const watcher = await t.connect(stream.id);
    await watcher.waitFor((f) => f.some((e) => e.event === 'snapshot'));
    t.window();
    await t.history.project(posted());
    const page = await t
      .history_(stream.id, `?minute=${minuteBucket(first.body.at)}`)
      .expect(200);
    expect(page.body.items).toHaveLength(2);
    const everything = JSON.stringify([
      first.body,
      second.body,
      (await t.snapshot(stream.id).expect(200)).body,
      watcher.frames.map((f) => f.raw),
      t.sent,
      page.body,
    ]);
    watcher.close();
    const local = viewer.email.split('@')[0];
    expect(everything).not.toContain(viewer.email);
    expect(everything).not.toContain(local);
  });
});
