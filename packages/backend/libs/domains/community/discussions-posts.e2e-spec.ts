import { v4 as uuidv4 } from 'uuid';
import { postPageSchema, postViewSchema } from '@marketplace-sandbox/contracts';
import { HTML_POLICY_VERSION } from './domain/content';
import { idTime } from './domain/ids';
import {
  createDiscussionsApp,
  type DiscussionsTestApp,
} from './testing/discussions-fixtures';

describe('Product discussions: boards, posts and idempotent create', () => {
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

  const count = async (table: string) =>
    Number((await t.cql(`SELECT count(*) AS n FROM ${table}`)).first().n);

  describe('US1 - create, validate and read a post', () => {
    it('S25 AS-01: a buyer posts to a product board: 201 with the full view, stored raw and rendered, event recorded, first in the new list', async () => {
      const res = await t
        .post(w.author, w.product.id, {
          title: 'Does it work with USB-C?',
          body: 'Planning to use it with a **laptop**.',
        })
        .expect(201);

      const post = postViewSchema.parse(res.body);
      expect(post).toMatchObject({
        boardId: w.product.id,
        authorId: w.author.id,
        title: 'Does it work with USB-C?',
        bodyHtml: '<p>Planning to use it with a <strong>laptop</strong>.</p>',
        ups: 0,
        downs: 0,
        score: 0,
        commentCount: 0,
        myVote: 0,
      });
      expect(idTime(post.postId).toISOString()).toBe(post.createdAt);

      const stored = (
        await t.cql('SELECT * FROM posts WHERE post_id = ?', [post.postId])
      ).first();
      expect(stored.body_md).toBe('Planning to use it with a **laptop**.');
      expect(stored.body_html).toBe(post.bodyHtml);
      expect(stored.html_version).toBe(HTML_POLICY_VERSION);
      expect(stored.shadow).toBe(false);

      const events = (
        await t.cql('SELECT type, aggregate_id FROM recorded_events')
      ).rows;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'discussion.post_created',
        aggregate_id: post.postId,
      });

      const list = await t
        .http()
        .get(`/api/boards/${w.product.id}/posts?sort=new`)
        .expect(200);
      expect(
        postPageSchema.parse(list.body).items.map((p) => p.postId),
      ).toEqual([post.postId]);
    });

    it('S25 AS-02: an unknown product is board_not_found, an archived one board_closed, a non-uuid board is refused; nothing is stored', async () => {
      const unknown = await t.post(w.author, uuidv4()).expect(404);
      expect(unknown.body.code).toBe('board_not_found');
      const closed = await t.post(w.author, w.archived.id).expect(409);
      expect(closed.body.code).toBe('board_closed');
      for (const bad of ['product-' + uuidv4(), 'brand:apple', 'not-a-uuid']) {
        const res = await t.post(w.author, bad).expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
      expect(await count('posts')).toBe(0);
      expect(await count('recorded_events')).toBe(0);
    });

    it.each([
      ['title missing', { title: undefined }, 'title'],
      ['title not a string', { title: 7 }, 'title'],
      ['title shorter than 3 characters', { title: 'ab' }, 'title'],
      ['title blank after trimming', { title: '     ' }, 'title'],
      ['title longer than 300 characters', { title: 'x'.repeat(301) }, 'title'],
      ['title with a control character', { title: 'ab\u0000cd' }, 'title'],
      ['title with a newline', { title: 'ab\ncd' }, 'title'],
      [
        'title with a bidirectional override',
        { title: `ab${String.fromCharCode(0x202e)}cd` },
        'title',
      ],
      ['body not a string', { body: 12 }, 'body'],
      [
        'body longer than 40,000 characters',
        { body: 'x'.repeat(40_001) },
        'body',
      ],
      ['an unknown field', { extra: 'x' }, 'extra'],
      [
        'markdown nested deeper than 20 levels',
        { body: '> '.repeat(21) + 'x' },
        'body',
      ],
    ])(
      'S25 AS-03: %s is 400 validation_failed and stores nothing',
      async (_name, change, field) => {
        const res = await t
          .post(w.author, w.product.id, change as Record<string, unknown>)
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(JSON.stringify(res.body.errors)).toContain(field);
        expect(JSON.stringify(res.body)).not.toContain('xxxxxxxxxx');
        expect(await count('posts')).toBe(0);
        expect(await count('recorded_events')).toBe(0);
      },
    );

    it('S25 AS-03: an empty body and a title with markup are valid (title-only post, title kept verbatim)', async () => {
      const empty = await t
        .post(w.author, w.product.id, { title: 'Title only', body: '' })
        .expect(201);
      expect(empty.body.bodyHtml).toBe('');
      const markup = await t
        .post(w.author, w.product.id, { title: '<b>x</b> bold?' })
        .expect(201);
      expect(markup.body.title).toBe('<b>x</b> bold?');
      const trimmed = await t
        .post(w.author, w.product.id, { title: '  padded title  ' })
        .expect(201);
      expect(trimmed.body.title).toBe('padded title');
    });

    it('S25 AS-04: every state-changing route answers 401 problem+json without credentials and touches no store', async () => {
      const id = uuidv4();
      const calls = [
        t
          .http()
          .post(`/api/boards/${w.product.id}/posts`)
          .set('Idempotency-Key', uuidv4())
          .send({ title: 'abc' }),
        t
          .http()
          .post(`/api/posts/${id}/comments`)
          .set('Idempotency-Key', uuidv4())
          .send({ body: 'x' }),
        t.http().delete(`/api/posts/${id}`),
        t.http().delete(`/api/comments/${id}`),
        t.http().put(`/api/votes/${id}`).send({ value: 1 }),
        t.http().put(`/api/moderation/shadow-bans/${id}`),
        t.http().delete(`/api/moderation/shadow-bans/${id}`),
      ];
      for (const call of calls) {
        const res = await call;
        expect(res.status).toBe(401);
        expect(res.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(res.body).toMatchObject({ status: 401, code: 'invalid_token' });
      }
      expect(await count('posts')).toBe(0);
    });

    it('S25 AS-41: anyone reads one post: myVote is null for anonymous and 0 for a signed-in reader; bad id 400, unknown 404', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const anon = await t.http().get(`/api/posts/${postId}`).expect(200);
      expect(postViewSchema.parse(anon.body)).toMatchObject({
        postId,
        myVote: null,
        ups: 0,
        downs: 0,
        commentCount: 0,
      });
      const signedIn = await t
        .as(w.reader)
        .get(`/api/posts/${postId}`)
        .expect(200);
      expect(postViewSchema.parse(signedIn.body).myVote).toBe(0);
      const bad = await t.http().get('/api/posts/not-a-uuid').expect(400);
      expect(bad.body.code).toBe('validation_failed');
      const missing = await t.http().get(`/api/posts/${uuidv4()}`).expect(404);
      expect(missing.body.code).toBe('post_not_found');
    });
  });

  describe('US1 - rate limit, idempotency and delete', () => {
    it('S25 AS-05: the eleventh write in a minute is 429 with the rate-limit headers; the ten earlier posts are stored; the next minute allows a write', async () => {
      for (let i = 0; i < 10; i++)
        await t
          .post(w.author, w.product.id, { title: `Post number ${i}` })
          .expect(201);
      const refused = await t
        .post(w.author, w.product.id, { title: 'One too many' })
        .expect(429);
      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      expect(refused.headers['ratelimit']).toBeDefined();
      expect(refused.headers['ratelimit-policy']).toBeDefined();
      expect(await count('posts')).toBe(10);

      t.clock.advance(61_000);
      await t
        .post(w.author, w.product.id, { title: 'After the minute' })
        .expect(201);
      expect(await count('posts')).toBe(11);
    });

    it('S25 AS-06: a missing or malformed Idempotency-Key is 422', async () => {
      const missing = await t
        .as(w.author)
        .post(`/api/boards/${w.product.id}/posts`)
        .send({ title: 'No key here' })
        .expect(422);
      expect(missing.body.code).toBe('idempotency_key_required');
      const malformed = await t
        .post(w.author, w.product.id, {}, 'not a valid key!')
        .expect(422);
      expect(malformed.body.code).toBe('idempotency_key_invalid');
      expect(await count('posts')).toBe(0);
    });

    it('S25 AS-06: replaying a completed key returns the stored post once; a different body under the same key is 422 idempotency_key_reuse and changes nothing', async () => {
      const key = uuidv4();
      const first = await t
        .post(w.author, w.product.id, { title: 'Original title' }, key)
        .expect(201);
      const replay = await t
        .post(w.author, w.product.id, { title: 'Original title' }, key)
        .expect(201);
      expect(replay.body).toEqual(first.body);
      expect(await count('posts')).toBe(1);

      const reuse = await t
        .post(w.author, w.product.id, { title: 'Another title' }, key)
        .expect(422);
      expect(reuse.body.code).toBe('idempotency_key_reuse');
      const stored = (
        await t.cql('SELECT title FROM posts WHERE post_id = ?', [
          first.body.postId,
        ])
      ).first();
      expect(stored.title).toBe('Original title');
      expect(await count('posts')).toBe(1);
    });

    it('S25 AS-06: five identical concurrent creates make one post, repeated 20 times', async () => {
      const users = await t.users(20);
      for (const user of users) {
        const key = uuidv4();
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            t.post(user, w.product.id, { title: 'Double click' }, key),
          ),
        );
        const created = results.filter((r) => r.status === 201);
        expect(created.length).toBeGreaterThanOrEqual(1);
        expect(new Set(created.map((r) => r.body.postId)).size).toBe(1);
        for (const r of results.filter((x) => x.status !== 201)) {
          expect(r.status).toBe(409);
          expect(r.body.code).toBe('idempotency_in_flight');
        }
      }
      expect(await count('posts')).toBe(20);
    });

    it('S25 AS-06: the key is scoped to the user: another user sending the same key creates their own post', async () => {
      const key = uuidv4();
      const mine = await t.post(w.author, w.product.id, {}, key).expect(201);
      const theirs = await t.post(w.reader, w.product.id, {}, key).expect(201);
      expect(theirs.body.postId).not.toBe(mine.body.postId);
      expect(theirs.body.authorId).toBe(w.reader.id);
      expect(await count('posts')).toBe(2);
    });

    it('S25 AS-06: a key replayed 24 hours and one second later is a new request and creates a second post', async () => {
      const key = uuidv4();
      const first = await t
        .post(w.author, w.product.id, { title: 'Same request' }, key)
        .expect(201);
      t.clock.advance(24 * 3_600_000 + 1_000);
      await t.reauth(w.author); // the access token expired with the day
      const again = await t
        .post(w.author, w.product.id, { title: 'Same request' }, key)
        .expect(201);
      expect(again.body.postId).not.toBe(first.body.postId);
      expect(await count('posts')).toBe(2);
    });

    it('S25 AS-47: the author deletes a post: 204, gone from lists and rankings, 404 for readers, comments unreachable, post_deleted recorded once, body erased', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const commentId = await t.newComment(w.reader, postId);
      await t.as(w.author).delete(`/api/posts/${postId}`).expect(204);

      for (const sort of ['new', 'hot', 'top']) {
        const page = await t
          .http()
          .get(`/api/boards/${w.product.id}/posts?sort=${sort}`)
          .expect(200);
        expect(page.body.items).toEqual([]);
      }
      const gone = await t.http().get(`/api/posts/${postId}`).expect(404);
      expect(gone.body.code).toBe('post_not_found');
      expect((await t.http().get(`/api/posts/${postId}/comments`)).status).toBe(
        404,
      );
      const create = await t
        .comment(w.reader, postId, { body: 'late' })
        .expect(404);
      expect(create.body.code).toBe('post_not_found');
      expect((await t.vote(w.author, commentId, 1)).status).toBe(404);

      const row = (
        await t.cql('SELECT * FROM posts WHERE post_id = ?', [postId])
      ).first();
      expect(row.deleted).toBe(true);
      expect(row.deleted_by).toBe('author');
      expect(row.body_md).toBeNull();
      const deleted = (
        await t.cql('SELECT * FROM recorded_events')
      ).rows.filter((e) => e.type === 'discussion.post_deleted');
      expect(deleted).toHaveLength(1);
      expect(JSON.parse(deleted[0].payload).payload).toMatchObject({
        postId,
        deletedBy: 'author',
      });

      await t.as(w.author).delete(`/api/posts/${postId}`).expect(204);
      const again = (await t.cql('SELECT * FROM recorded_events')).rows.filter(
        (e) => e.type === 'discussion.post_deleted',
      );
      expect(again).toHaveLength(1);
    });

    it('S25 AS-47: another user is 403, a moderator may delete (deletedBy moderator) and still read the removed post, unknown is 404', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const other = await t
        .as(w.reader)
        .delete(`/api/posts/${postId}`)
        .expect(403);
      expect(other.body.code).toBe('forbidden');
      expect((await t.http().get(`/api/posts/${postId}`)).status).toBe(200);

      await t.as(w.moderator).delete(`/api/posts/${postId}`).expect(204);
      const row = (
        await t.cql('SELECT deleted_by FROM posts WHERE post_id = ?', [postId])
      ).first();
      expect(row.deleted_by).toBe('moderator');
      const seen = await t
        .as(w.moderator)
        .get(`/api/posts/${postId}`)
        .expect(200);
      expect(seen.body.bodyHtml).toBe('');

      const stranger = await t
        .as(w.reader)
        .delete(`/api/posts/${postId}`)
        .expect(404);
      expect(stranger.body.code).toBe('post_not_found');
      const unknown = await t
        .as(w.reader)
        .delete(`/api/posts/${uuidv4()}`)
        .expect(404);
      expect(unknown.body.code).toBe('post_not_found');
    });
  });
});

describe('Product discussions: boards, posts and idempotent create (limiter store down)', () => {
  let t: DiscussionsTestApp;

  beforeAll(async () => {
    t = await createDiscussionsApp({ redisProxy: true });
  });
  afterAll(() => t.close());

  it('S25 AS-05: when the limiter store is down, writes fail closed with 503 rate_limiter_unavailable and store nothing', async () => {
    await t.reset();
    const w = await t.world();
    await t
      .post(w.author, w.product.id, { title: 'While it works' })
      .expect(201);
    t.redisProxy!.mode = 'refuse';
    try {
      const res = await t.post(w.author, w.product.id, {
        title: 'While it is down',
      });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('rate_limiter_unavailable');
    } finally {
      t.redisProxy!.mode = 'pass';
    }
    const n = Number(
      (await t.cql('SELECT count(*) AS n FROM posts')).first().n,
    );
    expect(n).toBe(1);
  });
});
