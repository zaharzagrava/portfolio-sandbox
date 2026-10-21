import { v4 as uuidv4 } from 'uuid';
import {
  commentThreadPageSchema,
  postPageSchema,
  postViewSchema,
  voteResultSchema,
} from '@marketplace-sandbox/contracts';
import {
  createDiscussionsApp,
  type DiscussionsTestApp,
} from './testing/discussions-fixtures';

describe('Product discussions: votes, concurrency and rate limits', () => {
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

  const records = async (targetId: string) =>
    (
      await t.cql(
        'SELECT user_id, value, weight FROM votes_by_target WHERE target_id = ?',
        [targetId],
      )
    ).rows;
  const post = async (postId: string, user?: typeof w.reader) => {
    const req = user
      ? t.as(user).get(`/api/posts/${postId}`)
      : t.http().get(`/api/posts/${postId}`);
    return postViewSchema.parse((await req.expect(200)).body);
  };
  const cast = (user: typeof w.reader, targetId: string, value: unknown) =>
    t.vote(user, targetId, value);

  describe('US3 - cast, change and retract votes', () => {
    it.each(['post', 'comment'] as const)(
      'S25 AS-24: a vote on a %s moves the score by 1, then -2, then +1, with one record in the store',
      async (type) => {
        const postId = await t.newPost(w.author, w.product.id);
        const target =
          type === 'post' ? postId : await t.newComment(w.author, postId);

        const up = await cast(w.reader, target, 1).expect(200);
        expect(voteResultSchema.parse(up.body)).toEqual({
          targetId: target,
          targetType: type,
          ups: 1,
          downs: 0,
          score: 1,
          myVote: 1,
        });
        expect(await records(target)).toHaveLength(1);

        const down = await cast(w.reader, target, -1).expect(200);
        expect(voteResultSchema.parse(down.body)).toEqual({
          targetId: target,
          targetType: type,
          ups: 0,
          downs: 1,
          score: -1,
          myVote: -1,
        });
        const [record] = await records(target);
        expect(record.value).toBe(-1);

        const none = await cast(w.reader, target, 0).expect(200);
        expect(voteResultSchema.parse(none.body)).toEqual({
          targetId: target,
          targetType: type,
          ups: 0,
          downs: 0,
          score: 0,
          myVote: 0,
        });
        expect(await records(target)).toHaveLength(0);
      },
    );

    it('S25 AS-25: repeating a vote returns the same complete result; retracting a vote that does not exist changes nothing', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const first = await cast(w.reader, postId, 1).expect(200);
      const again = await cast(w.reader, postId, 1).expect(200);
      expect(again.body).toEqual(first.body);
      expect(voteResultSchema.parse(again.body).ups).toBe(1);
      expect(await records(postId)).toHaveLength(1);

      const nobody = (await t.users(1))[0];
      const retract = await cast(nobody, postId, 0).expect(200);
      expect(voteResultSchema.parse(retract.body)).toMatchObject({
        ups: 1,
        downs: 0,
        myVote: 0,
      });
      expect(await records(postId)).toHaveLength(1);
    });

    it.each([
      ['value missing', {}],
      ['value 2', { value: 2 }],
      ['value -2', { value: -2 }],
      ['value 0.5', { value: 0.5 }],
      ['value as a string', { value: '1' }],
      ['value null', { value: null }],
      ['a client-sent targetType', { value: 1, targetType: 'post' }],
      ['an unknown field', { value: 1, weight: 1 }],
    ])(
      'S25 AS-26: %s is 400 validation_failed and stores nothing',
      async (_name, body) => {
        const postId = await t.newPost(w.author, w.product.id);
        const res = await t
          .as(w.reader)
          .put(`/api/votes/${postId}`)
          .send(body)
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await records(postId)).toHaveLength(0);
      },
    );

    it('S25 AS-26: a target id that is not a uuid is 400 and an unknown target is 404 target_not_found', async () => {
      const bad = await cast(w.reader, 'not-a-uuid', 1).expect(400);
      expect(bad.body.code).toBe('validation_failed');
      const unknown = await cast(w.reader, uuidv4(), 1).expect(404);
      expect(unknown.body.code).toBe('target_not_found');
      expect(
        Number(
          (await t.cql('SELECT count(*) AS n FROM votes_by_target')).first().n,
        ),
      ).toBe(0);
    });

    it('S25 AS-27: voting on your own post or comment is 422 self_vote_not_allowed and stores nothing', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const commentId = await t.newComment(w.reader, postId);
      for (const [user, target] of [
        [w.author, postId],
        [w.reader, commentId],
      ] as const) {
        const res = await cast(user, target, 1).expect(422);
        expect(res.body.code).toBe('self_vote_not_allowed');
        expect(await records(target)).toHaveLength(0);
      }
    });

    it('S25 AS-28: a deleted comment is 409 target_deleted and a deleted post is 404 target_not_found; counts do not move', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const commentId = await t.newComment(w.author, postId);
      await cast(w.reader, commentId, 1).expect(200);
      await cast(w.reader, postId, 1).expect(200);
      await t.as(w.author).delete(`/api/comments/${commentId}`).expect(204);
      const other = (await t.users(1))[0];
      const comment = await cast(other, commentId, 1).expect(409);
      expect(comment.body.code).toBe('target_deleted');
      expect(await records(commentId)).toHaveLength(1);

      await t.as(w.author).delete(`/api/posts/${postId}`).expect(204);
      const deletedPost = await cast(other, postId, 1).expect(404);
      expect(deletedPost.body.code).toBe('target_not_found');
      expect(await records(postId)).toHaveLength(1);
    });

    it("S25 AS-32: myVote is the reader's own vote when signed in and null when anonymous, on a post, in a list and in a thread", async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const commentId = await t.newComment(w.author, postId);
      await cast(w.reader, postId, -1).expect(200);
      await cast(w.reader, commentId, 1).expect(200);

      expect((await post(postId, w.reader)).myVote).toBe(-1);
      expect((await post(postId)).myVote).toBeNull();
      const list = (user?: typeof w.reader) =>
        (user
          ? t.as(user).get(`/api/boards/${w.product.id}/posts?sort=new`)
          : t.http().get(`/api/boards/${w.product.id}/posts?sort=new`)
        ).expect(200);
      expect(
        postPageSchema.parse((await list(w.reader)).body).items[0].myVote,
      ).toBe(-1);
      expect(
        postPageSchema.parse((await list()).body).items[0].myVote,
      ).toBeNull();
      const threadOf = (user?: typeof w.reader) =>
        (user
          ? t.as(user).get(`/api/posts/${postId}/comments?sort=old`)
          : t.http().get(`/api/posts/${postId}/comments?sort=old`)
        ).expect(200);
      expect(
        commentThreadPageSchema.parse((await threadOf(w.reader)).body).items[0]
          .myVote,
      ).toBe(1);
      expect(
        commentThreadPageSchema.parse((await threadOf()).body).items[0].myVote,
      ).toBeNull();
      expect((await post(postId, (await t.users(1))[0])).myVote).toBe(0);
    });
  });

  describe('US3 - concurrency and rate limits', () => {
    it('S25 AS-29: 100 distinct voters at once count exactly 100, as the store records and after the cache is flushed', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const voters = await t.users(100, { aged: true });
      const results = await Promise.all(voters.map((v) => cast(v, postId, 1)));
      expect(results.map((r) => r.status)).toEqual(Array(100).fill(200));
      expect((await post(postId)).ups).toBe(100);
      expect(await records(postId)).toHaveLength(100);

      await t.flushDiscussionCache();
      const after = await post(postId);
      expect(after).toMatchObject({ ups: 100, downs: 0, score: 100 });
    });

    it('S25 AS-30: five identical concurrent votes by one user are 200 or 409 vote_in_progress, at least one 200, and count once', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => cast(w.reader, postId, 1)),
      );
      expect(results.some((r) => r.status === 200)).toBe(true);
      for (const r of results.filter((x) => x.status !== 200)) {
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('vote_in_progress');
        expect(r.headers['retry-after']).toBeDefined();
      }
      expect((await post(postId)).ups).toBe(1);
      expect(await records(postId)).toHaveLength(1);
    });

    it('S25 AS-30: a +1 racing a -1 from one user leaves exactly one of the two, with counts equal to the records, 20 times', async () => {
      const authors = await t.users(20);
      // Phase 1: the 20 races run side by side (each has its own post). Phase 2: the cache is flushed once and every
      // post is read again from the store, so each post is still checked against a cold cache.
      const rounds = await Promise.all(
        authors.map(async (author) => {
          const postId = await t.newPost(author, w.product.id);
          await Promise.all([
            cast(w.reader, postId, 1),
            cast(w.reader, postId, -1),
          ]);
          const stored = await records(postId);
          expect(stored).toHaveLength(1);
          const shown = await post(postId);
          expect(shown.ups + shown.downs).toBe(1);
          expect(shown.ups).toBe(stored[0].value === 1 ? 1 : 0);
          expect(shown.downs).toBe(stored[0].value === -1 ? 1 : 0);
          return { postId, shown };
        }),
      );
      await t.flushDiscussionCache();
      await Promise.all(
        rounds.map(async ({ postId, shown }) => {
          const rebuilt = await post(postId);
          expect([rebuilt.ups, rebuilt.downs]).toEqual([
            shown.ups,
            shown.downs,
          ]);
        }),
      );
    });

    it('S25 AS-31: the 61st vote in a minute is 429 with the rate-limit headers; the 60 earlier ones are stored', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      for (let i = 0; i < 60; i++)
        await cast(w.reader, postId, i % 2 === 0 ? 1 : -1).expect(200);
      const [record] = await records(postId);
      expect(record.value).toBe(-1); // the 60th vote
      const refused = await cast(w.reader, postId, 1).expect(429);
      expect(refused.body.code).toBe('rate_limited');
      expect(refused.headers['retry-after']).toBeDefined();
      expect(refused.headers['ratelimit']).toBeDefined();
      expect((await records(postId))[0].value).toBe(-1);

      t.clock.advance(61_000);
      await t.reauth(w.reader);
      await cast(w.reader, postId, 1).expect(200);
    });
  });
});
