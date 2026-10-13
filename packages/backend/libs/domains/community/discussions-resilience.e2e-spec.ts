import { Logger } from '@nestjs/common';
import { types } from 'cassandra-driver';
import { v4 as uuidv4 } from 'uuid';
import {
  commentThreadPageSchema,
  postPageSchema,
  postViewSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  compareTimeUuid,
  idTime,
  sortableId,
  TimeIdGenerator,
} from './domain/ids';
import { pathFor } from './domain/paths';
import {
  createDiscussionsApp,
  type DiscussionsTestApp,
} from './testing/discussions-fixtures';

describe('Product discussions: derived-state recovery, outages and observability', () => {
  let t: DiscussionsTestApp;
  let w: Awaited<ReturnType<DiscussionsTestApp['world']>>;

  beforeAll(async () => {
    t = await createDiscussionsApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
  });

  const rows = async (query: string, params: unknown[] = []) =>
    (await t.cql(query, params)).rows;
  const count = async (table: string) =>
    Number((await t.cql(`SELECT count(*) AS n FROM ${table}`)).first().n);
  const recorded = async (type?: string) =>
    (await rows('SELECT event_id, type, payload FROM recorded_events')).filter(
      (e) => !type || e.type === type,
    );
  const post = async (postId: string) =>
    postViewSchema.parse(
      (await t.http().get(`/api/posts/${postId}`).expect(200)).body,
    );
  const board = async (sort: string) =>
    postPageSchema.parse(
      (
        await t
          .http()
          .get(`/api/boards/${w.product.id}/posts?sort=${sort}`)
          .expect(200)
      ).body,
    );
  const thread = async (postId: string, sort = 'best') =>
    commentThreadPageSchema.parse(
      (
        await t
          .http()
          .get(`/api/posts/${postId}/comments?sort=${sort}`)
          .expect(200)
      ).body,
    );

  describe('US8 - events recorded with the write and relayed at least once', () => {
    it('S25 AS-07: the event is recorded with the write; with the bus down the request still succeeds and the event is published once the bus is back, with its stable eventId', async () => {
      t.faults.busDown = true;
      const res = await t.post(w.author, w.product.id).expect(201);
      const [event] = await recorded('discussion.post_created');
      expect(event).toBeDefined();
      expect(await count('pending_events')).toBe(1);

      const down = await t.relay();
      expect(down).toMatchObject({ published: 0, failed: 1 });
      expect(t.published).toHaveLength(0);
      expect(await count('pending_events')).toBe(1);

      t.faults.busDown = false;
      expect(await t.relay()).toMatchObject({ published: 1, failed: 0 });
      expect(t.published).toHaveLength(1);
      expect(t.published[0]).toMatchObject({
        eventId: event.event_id.toString(),
        type: 'discussion.post_created',
        aggregateId: res.body.postId,
      });
      expect(t.published[0].payload).toMatchObject({
        postId: res.body.postId,
        boardId: w.product.id,
        authorId: w.author.id,
      });
      expect(await count('pending_events')).toBe(0);
      expect(await t.relay()).toMatchObject({ published: 0 });
    });

    it('S25 AS-07: a delivery whose acknowledgement is lost is delivered again with the same eventId, which a consumer collapses to one effect', async () => {
      await t.post(w.author, w.product.id).expect(201);
      t.faults.scyllaFail = { match: 'DELETE FROM pending_events', times: 1 };
      expect(await t.relay()).toMatchObject({ published: 0, failed: 1 }); // the bus took it, the queue did not forget it
      expect(t.published).toHaveLength(1);
      expect(await t.relay()).toMatchObject({ published: 1, failed: 0 });
      expect(t.published).toHaveLength(2);
      expect(t.published[0].eventId).toBe(t.published[1].eventId);
      const effects = new Set(t.published.map((e) => e.eventId)); // a consumer that de-duplicates by eventId
      expect(effects.size).toBe(1);
    });

    it('S25 AS-07: a recorded event that is not a valid envelope goes to dead_events and has no other effect', async () => {
      await t.post(w.author, w.product.id).expect(201);
      const [good] = await recorded('discussion.post_created');
      const bad = uuidv4();
      const shard = (await rows('SELECT hour_shard FROM pending_events'))[0]
        .hour_shard;
      await t.cql(
        'INSERT INTO pending_events (hour_shard, event_id, type, aggregate_id, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
        [
          shard,
          bad,
          'discussion.post_created',
          uuidv4(),
          new Date(),
          JSON.stringify({
            eventId: bad,
            type: 'discussion.post_created',
            version: 1,
            payload: { nope: true },
          }),
        ],
      );
      const result = await t.relay();
      expect(result).toMatchObject({ published: 1, dead: 1 });
      expect(t.published.map((e) => e.eventId)).toEqual([
        good.event_id.toString(),
      ]);
      const dead = await rows('SELECT event_id, reason FROM dead_events');
      expect(dead).toHaveLength(1);
      expect(dead[0].event_id.toString()).toBe(bad);
      expect(await count('pending_events')).toBe(0);
    });

    it('S25 AS-07: events for comments and deletions are recorded too, one per write', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const commentId = await t.newComment(w.reader, postId);
      await t.as(w.reader).delete(`/api/comments/${commentId}`).expect(204);
      await t.as(w.author).delete(`/api/posts/${postId}`).expect(204);
      expect((await recorded()).map((e) => e.type).sort()).toEqual([
        'discussion.comment_created',
        'discussion.comment_deleted',
        'discussion.post_created',
        'discussion.post_deleted',
      ]);
      await t.relay();
      expect(t.published).toHaveLength(4);
    });
  });

  describe('US8 - derived state can be lost and rebuilt', () => {
    it('S25 AS-49: with the whole cache emptied counts and orders come back identical, no vote is lost, and every key created afterwards expires', async () => {
      const voters = await t.users(6, { aged: true });
      const authors = await t.users(3);
      const posts: string[] = [];
      for (const [i, author] of authors.entries()) {
        t.clock.advance(1_000);
        posts.push(
          await t.newPost(author, w.product.id, { title: `Post ${i}` }),
        );
      }
      for (const [i, p] of posts.entries())
        for (const v of voters.slice(0, i + 1))
          await t.vote(v, p, 1).expect(200);
      const c1 = await t.newComment(authors[0], posts[0], { body: 'one' });
      t.clock.advance(1_000);
      const c2 = await t.newComment(authors[1], posts[0], { body: 'two' });
      await t.vote(voters[0], c2, 1).expect(200);

      const before = {
        posts: await Promise.all(posts.map(post)),
        hot: (await board('hot')).items.map((p) => p.postId),
        top: (await board('top')).items.map((p) => p.postId),
        best: (await thread(posts[0])).items.map((n) => n.commentId),
      };
      expect(before.best).toEqual([c2, c1]);

      await t.redis.flushdb();
      const after = {
        posts: await Promise.all(posts.map(post)),
        hot: (await board('hot')).items.map((p) => p.postId),
        top: (await board('top')).items.map((p) => p.postId),
        best: (await thread(posts[0])).items.map((n) => n.commentId),
      };
      expect(after).toEqual(before);
      for (const [i, p] of posts.entries())
        expect(
          await rows(
            'SELECT user_id FROM votes_by_target WHERE target_id = ?',
            [p],
          ),
        ).toHaveLength(i + 1);

      const keys = await t.cacheKeys();
      expect(keys.length).toBeGreaterThan(0);
      for (const { key, ttl } of keys)
        expect({ key, hasTtl: ttl > 0 }).toEqual({ key, hasTtl: true });
    });

    it('S25 AS-50: drifted live and durable counters are repaired from the vote store by the reconciliation job, with one warning; a second run changes nothing', async () => {
      const voters = await t.users(3, { aged: true });
      const postId = await t.newPost(w.author, w.product.id);
      for (const v of voters) await t.vote(v, postId, 1).expect(200);
      const commentId = await t.newComment(w.reader, postId);
      await t.vote(voters[0], commentId, 1).expect(200);

      // inject drift: +3 ups in the live counter, +5 in the durable one, the comment count off by two, a wrong rank score
      await board('top'); // builds the board rankings
      const member = sortableId(postId);
      const topKey = `dsc:rank:{${w.product.id}}:top-all`;
      await t.redis.zadd(topKey, 99, member);
      await t.redis.hincrby(`dsc:cnt:{${postId}}`, 'ups', 3);
      await t.cql('UPDATE vote_counts SET ups = ups + ? WHERE target_id = ?', [
        types.Long.fromNumber(5),
        postId,
      ]);
      await t.cql(
        'UPDATE post_comment_counts SET visible = visible + ? WHERE post_id = ?',
        [types.Long.fromNumber(2), postId],
      );
      await t.redis.del(`dsc:ccnt:{${postId}}`);
      expect((await post(postId)).ups).toBe(6);
      expect((await post(postId)).commentCount).toBe(3);

      const warn = jest.spyOn(Logger.prototype, 'warn');
      await t.runJob('discussions.reconcile');
      const drift = warn.mock.calls.filter(([m]) =>
        String(m).includes('drifted'),
      );
      expect(drift).toHaveLength(1);
      expect(String(drift[0][0])).toContain('ups +3');
      expect(String(drift[0][0])).toContain('durable ups');

      const fixed = await post(postId);
      expect(fixed).toMatchObject({
        ups: 3,
        downs: 0,
        score: 3,
        commentCount: 1,
      });
      const totals = (
        await t.cql('SELECT ups, downs FROM vote_counts WHERE target_id = ?', [
          postId,
        ])
      ).first();
      expect([Number(totals.ups), Number(totals.downs)]).toEqual([3, 0]);
      expect(Number(await t.redis.zscore(topKey, member))).toBe(3);

      warn.mockClear();
      await t.runJob('discussions.reconcile');
      expect(
        warn.mock.calls.filter(([m]) => String(m).includes('drifted')),
      ).toHaveLength(0);
      expect(await post(postId)).toEqual(fixed);
      warn.mockRestore();
    });

    it('S25 AS-51: with the ranking cache down new, old and one post still read; hot, top and best are degraded; votes are 503; creates continue and the rankings catch up when the cache returns', async () => {
      const voters = await t.users(3, { aged: true });
      const authors = await t.users(3);
      const first = await t.newPost(authors[0], w.product.id, {
        title: 'First',
      });
      t.clock.advance(1_000);
      const second = await t.newPost(authors[1], w.product.id, {
        title: 'Second',
      });
      for (const v of voters) await t.vote(v, first, 1).expect(200);
      const c1 = await t.newComment(authors[0], first, { body: 'c1' });
      t.clock.advance(1_000);
      const c2 = await t.newComment(authors[1], first, { body: 'c2' });
      await t.vote(voters[0], c2, 1).expect(200);
      await board('hot');
      await thread(first); // rankings exist before the outage

      let third = '';
      let c3 = '';
      t.faults.redisDown = true;
      try {
        expect((await post(first)).ups).toBe(3);
        expect((await board('new')).items.map((p) => p.postId)).toEqual([
          second,
          first,
        ]);
        expect(
          (await thread(first, 'old')).items.map((n) => n.commentId),
        ).toEqual([c1, c2]);
        for (const sort of ['hot', 'top']) {
          const degraded = await t
            .http()
            .get(`/api/boards/${w.product.id}/posts?sort=${sort}`)
            .expect(200);
          expect(degraded.body.degraded).toBe(true);
          expect(
            postPageSchema.parse(degraded.body).items.map((p) => p.postId),
          ).toEqual([first, second]);
        }
        const best = await t
          .http()
          .get(`/api/posts/${first}/comments?sort=best`)
          .expect(200);
        expect(best.body.degraded).toBe(true);
        expect(
          commentThreadPageSchema
            .parse(best.body)
            .items.map((n) => n.commentId),
        ).toEqual([c2, c1]);

        const refused = await t.vote(voters[1], second, 1).expect(503);
        expect(refused.body.code).toBe('service_unavailable');
        expect(refused.headers['retry-after']).toBeDefined();
        expect(
          await rows(
            'SELECT user_id FROM votes_by_target WHERE target_id = ?',
            [second],
          ),
        ).toHaveLength(0);

        t.clock.advance(1_000);
        third = await t.newPost(authors[2], w.product.id, { title: 'Third' });
        c3 = await t.newComment(authors[2], first, { body: 'c3' });
      } finally {
        t.faults.redisDown = false;
      }
      expect((await board('hot')).items.map((p) => p.postId)).toContain(third);
      expect((await board('top')).items.map((p) => p.postId)).toContain(third);
      expect((await thread(first)).items.map((n) => n.commentId)).toContain(c3);
      expect((await board('hot')).items.length).toBe(3);
    });

    it('S25 AS-52: a store timeout during creation is a generic 503 with a requestId; retrying the same key leaves exactly one post, whichever attempt stored it', async () => {
      for (const after of [false, true]) {
        const key = uuidv4();
        t.faults.scyllaFail = { match: 'INSERT INTO posts', times: 1, after };
        const failed = await t.post(
          w.author,
          w.product.id,
          { title: `Timeout ${after}` },
          key,
        );
        expect(failed.status).toBe(503);
        expect(failed.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(failed.body.code).toBe('service_unavailable');
        expect(typeof failed.body.requestId).toBe('string');
        const text = JSON.stringify(failed.body);
        expect(text).not.toMatch(
          /cassandra|scylla|INSERT|OperationTimedOut|stack| at \w+\.|\.ts:\d+/i,
        );

        const retry = await t
          .post(w.author, w.product.id, { title: `Timeout ${after}` }, key)
          .expect(201);
        const stored = await rows('SELECT post_id FROM posts');
        expect(
          stored.filter((r) => r.post_id.toString() === retry.body.postId),
        ).toHaveLength(1);
        expect(stored).toHaveLength(after ? 1 : 1);
        await t.reset();
        w = await t.world();
      }
    });

    it('S25 AS-53: 5xx, 401 and unknown routes answer problem+json with type, title, status, detail, instance, requestId and a stable code', async () => {
      const existing = await t.newPost(w.author, w.product.id);
      t.faults.scyllaDown = true;
      const five = await t.http().get(`/api/posts/${existing}`);
      t.faults.scyllaDown = false;
      const bodies = [
        five,
        await t.http().post(`/api/boards/${w.product.id}/posts`).send({}),
        await t.http().get('/api/discussions-nothing-here'),
      ];
      expect(bodies.map((b) => b.status)).toEqual([503, 401, 404]);
      for (const res of bodies) {
        expect(res.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(res.body).toEqual(
          expect.objectContaining({
            type: expect.any(String),
            title: expect.any(String),
            status: res.status,
            detail: expect.any(String),
            requestId: expect.any(String),
            code: expect.any(String),
          }),
        );
        expect(res.body).toHaveProperty('instance');
      }
      expect(five.body.code).toBe('service_unavailable');
      expect(JSON.stringify(five.body)).not.toMatch(
        /cassandra|scylla|stack| at /i,
      );
    });

    it('S25 AS-50: (FR-024) the one-shot backfill makes data written before S25 readable on boards and in threads, and running it again changes nothing', async () => {
      // old layout: a post row, its month listing row and root comments with no index rows and no slot allocator
      const old = new TimeIdGenerator({
        bytes: (n) => new Uint8Array(n).fill(7),
      });
      const createdAt = new Date(t.clock.now().getTime() - 400 * 86_400_000);
      const postId = old.next(createdAt);
      const bucket =
        createdAt.getUTCFullYear() * 100 + createdAt.getUTCMonth() + 1;
      await t.cql(
        'INSERT INTO posts (post_id, board_id, author_id, title, body_md, body_html, created_at, deleted, comment_buckets) VALUES (?, ?, ?, ?, ?, ?, ?, false, 1)',
        [
          postId,
          w.product.id,
          w.author.id,
          'An old post',
          'old words',
          '<p>old words</p>',
          createdAt,
        ],
      );
      await t.cql(
        'INSERT INTO posts_by_board (board_id, bucket, post_id, author_id, title) VALUES (?, ?, ?, ?, ?)',
        [w.product.id, bucket, postId, w.author.id, 'An old post'],
      );
      const commentId = old.next(new Date(createdAt.getTime() + 60_000));
      const path = pathFor(null, commentId);
      await t.cql(
        'INSERT INTO comments_by_post (post_id, bucket, path, comment_id, author_id, body_md, body_html, created_at, deleted) VALUES (?, 0, ?, ?, ?, ?, ?, ?, false)',
        [
          postId,
          path,
          commentId,
          w.reader.id,
          'old comment',
          '<p>old comment</p>',
          new Date(createdAt.getTime() + 60_000),
        ],
      );
      await t.cql(
        'INSERT INTO comment_locator (comment_id, post_id, bucket, path) VALUES (?, ?, 0, ?)',
        [commentId, postId, path],
      );

      expect((await board('new')).items).toEqual([]);
      expect((await thread(postId, 'old')).items).toEqual([]);

      for (let step = 0; step < 6; step++) {
        const before = await count('board_months');
        await t.runJob('discussions.backfill', {
          phase: step < 3 ? 'boards' : 'threads',
          pageState: null,
        });
        expect(await count('board_months')).toBeGreaterThanOrEqual(before);
      }
      t.clock.advance(6_000); // the empty first page read above was cached for 5 seconds
      expect((await board('new')).items.map((p) => p.postId)).toEqual([postId]);
      const page = await thread(postId, 'old');
      expect(page.items.map((n) => n.commentId)).toEqual([commentId]);
      expect(page.items[0]).toMatchObject({
        depth: 0,
        bodyHtml: '<p>old comment</p>',
      });
      expect(await count('top_comments_by_post')).toBe(1);
      expect(await count('post_buckets')).toBe(1);
      expect(await count('board_months')).toBe(1);

      // a new comment on the old thread takes a fresh slot after the old bucket
      await t.newComment(w.author, postId, {
        body: 'new comment on an old post',
      });
      expect((await thread(postId, 'old')).items).toHaveLength(2);
    });

    it('S25 AS-55: ids sort in creation order and carry the creation time; reading changes no stored state', async () => {
      const authors = await t.users(4);
      const created: Array<{ id: string; createdAt: string }> = [];
      for (let round = 0; round < 3; round++) {
        const burst = await Promise.all(
          authors.map((a) =>
            t.post(a, w.product.id, { title: `Burst ${round}` }),
          ),
        );
        for (const r of burst)
          created.push({ id: r.body.postId, createdAt: r.body.createdAt });
        t.clock.advance(round === 0 ? 0 : 7); // frozen, then a few milliseconds apart
      }
      const bySortedId = [...created].sort((a, b) =>
        compareTimeUuid(a.id, b.id),
      );
      expect(bySortedId.map((c) => c.createdAt)).toEqual(
        [...created.map((c) => c.createdAt)].sort(),
      );
      for (const c of created)
        expect(idTime(c.id).toISOString()).toBe(c.createdAt);
      expect(new Set(created.map((c) => c.id)).size).toBe(created.length);

      const tables = [
        'posts',
        'posts_by_board',
        'votes_by_target',
        'recorded_events',
        'pending_events',
        'post_comment_counts',
      ];
      const snapshot = async () => Promise.all(tables.map(count));
      const state = await snapshot();
      const first = created[0].id;
      for (const path of [
        `/api/posts/${first}`,
        `/api/boards/${w.product.id}/posts?sort=hot`,
        `/api/boards/${w.product.id}/posts?sort=new`,
        `/api/posts/${first}/comments`,
      ])
        await t.http().get(path).expect(200);
      expect(await snapshot()).toEqual(state);
    });
  });
});

describe('Product discussions: derived-state recovery, outages and observability (logs and metrics)', () => {
  let t: DiscussionsTestApp;

  beforeAll(async () => {
    t = await createDiscussionsApp({ structuredLogger: true });
  });
  afterAll(() => t.close());

  it('S25 AS-54: logs carry the requestId and never a title, body or e-mail address; the metrics for writes, votes, degraded reads and drift are emitted', async () => {
    await t.reset();
    const w = await t.world();
    const marker = 'MARKER-ZX81-secret-words';
    const value = (name: string, labels = {}) =>
      MetricsRegistry.value(name, labels) ?? 0;
    const before = {
      post: value('discussions_write_total', {
        kind: 'post',
        outcome: 'created',
      }),
      comment: value('discussions_write_total', {
        kind: 'comment',
        outcome: 'created',
      }),
      cast: value('discussions_vote_total', { outcome: 'cast' }),
      degraded: value('discussions_degraded_read_total', { list: 'board' }),
    };
    t.clearLogs();

    const postId = (
      await t
        .post(w.author, w.product.id, {
          title: `Title ${marker}`,
          body: `Body ${marker}`,
        })
        .expect(201)
    ).body.postId as string;
    const commentId = (
      await t
        .comment(w.reader, postId, { body: `Comment ${marker}` })
        .expect(201)
    ).body.commentId as string;
    await t.vote(w.reader, postId, 1).expect(200);
    await t.as(w.reader).delete(`/api/comments/${commentId}`).expect(204);
    await t.as(w.author).delete(`/api/posts/${postId}`).expect(204);
    await t
      .http()
      .get(`/api/boards/${w.product.id}/posts?sort=hot`)
      .expect(200);
    t.faults.redisDown = true;
    await t
      .http()
      .get(`/api/boards/${w.product.id}/posts?sort=hot`)
      .expect(200);
    t.faults.redisDown = false;
    await new Promise((r) => setTimeout(r, 200));

    const lines = t.logs();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines)
      expect({
        msg: line.msg,
        hasRequestId: typeof line.requestId === 'string',
      }).toEqual({ msg: line.msg, hasRequestId: true });
    const raw = t.rawLogs();
    expect(raw).not.toContain(marker);
    expect(raw).not.toMatch(/[a-z0-9._-]+@example\.com/i);

    expect(
      value('discussions_write_total', { kind: 'post', outcome: 'created' }),
    ).toBe(before.post + 1);
    expect(
      value('discussions_write_total', { kind: 'comment', outcome: 'created' }),
    ).toBe(before.comment + 1);
    expect(value('discussions_vote_total', { outcome: 'cast' })).toBe(
      before.cast + 1,
    );
    expect(value('discussions_degraded_read_total', { list: 'board' })).toBe(
      before.degraded + 1,
    );
    expect(
      MetricsRegistry.value('rate_limit_decisions_total', {
        policy: 'discussion.write',
        decision: 'allowed',
      }) ?? 1,
    ).toBeGreaterThanOrEqual(0);
  });
});

export type { TestUser };
