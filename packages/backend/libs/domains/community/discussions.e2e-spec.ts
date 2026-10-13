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

/**
 * Smoke pass over the four behaviours the first discussions spec covered (thread order, vote flip,
 * a double-clicked vote, hot board + best comments), through the real HTTP API on ScyllaDB + Redis.
 * The detailed scenarios live in the discussions-*.e2e-spec.ts files next to this one.
 */
describe('Product discussions (e2e)', () => {
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

  const tick = () => t.clock.advance(1_000);
  const thread = async (postId: string, query: string) =>
    commentThreadPageSchema.parse(
      (
        await t
          .as(w.reader)
          .get(`/api/posts/${postId}/comments?${query}`)
          .expect(200)
      ).body,
    );
  const board = async (query: string) =>
    postPageSchema.parse(
      (
        await t
          .http()
          .get(`/api/boards/${w.product.id}/posts?${query}`)
          .expect(200)
      ).body,
    );
  const postView = async (postId: string) =>
    postViewSchema.parse(
      (await t.http().get(`/api/posts/${postId}`).expect(200)).body,
    );

  it('S25 AS-14: nested replies come back in thread order from one read', async () => {
    const [u1, u2, u3, u4] = await t.users(4);
    const postId = await t.newPost(w.author, w.product.id);
    const a = await t.newComment(u1, postId, { body: 'first' });
    tick();
    const b = await t.newComment(u2, postId, { body: 'second' });
    tick();
    const a1 = await t.newComment(u3, postId, { body: 'r', parentId: a });
    tick();
    const a1x = await t.newComment(u4, postId, { body: 'rr', parentId: a1 });

    const page = await thread(postId, 'sort=old');
    expect(page.items.map((n) => n.commentId)).toEqual([a, b]);
    expect(page.items[0].replies.map((r) => r.commentId)).toEqual([a1, a1x]);
    expect(page.items[0].replies.map((r) => r.depth)).toEqual([1, 2]);
  });

  it('S25 AS-24: flipping +1 to -1 moves the score by 2; S25 AS-29: 100 concurrent voters count exactly 100', async () => {
    const postId = await t.newPost(w.author, w.product.id);
    await t.vote(w.reader, postId, 1).expect(200);
    const flipped = await t.vote(w.reader, postId, -1).expect(200);
    expect(voteResultSchema.parse(flipped.body)).toMatchObject({
      ups: 0,
      downs: 1,
      score: -1,
    });

    const voters = await t.users(100, { aged: true });
    const results = await Promise.all(voters.map((v) => t.vote(v, postId, 1)));
    expect(results.map((r) => r.status)).toEqual(Array(100).fill(200));
    expect(await postView(postId)).toMatchObject({ ups: 100, downs: 1 });

    await t.flushDiscussionCache();
    expect(await postView(postId)).toMatchObject({ ups: 100, downs: 1 });
  });

  it('S25 AS-30: a double-clicked vote is applied once', async () => {
    const postId = await t.newPost(w.author, w.product.id);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => t.vote(w.reader, postId, 1)),
    );
    expect(results.some((r) => r.status === 200)).toBe(true);
    for (const r of results.filter((x) => x.status !== 200))
      expect(r.status).toBe(409);
    expect(await postView(postId)).toMatchObject({ ups: 1, downs: 0 });
  });

  it('S25 AS-33: a post that gets votes rises above an older unvoted one; S25 AS-42: best comments by Wilson score', async () => {
    const voters = await t.users(20, { aged: true });
    const [other] = await t.users(1);
    const older = await t.newPost(w.author, w.product.id, { title: 'older' });
    tick();
    const newer = await t.newPost(other, w.product.id, { title: 'newer' });
    for (const v of voters) await t.vote(v, older, 1).expect(200);

    expect((await board('sort=hot')).items.map((p) => p.postId)[0]).toBe(older);
    expect((await board('sort=new')).items.map((p) => p.postId)).toEqual([
      newer,
      older,
    ]);

    const [c1, c2] = await t.users(2);
    const lucky = await t.newComment(c1, older, { body: 'one upvote' });
    tick();
    const solid = await t.newComment(c2, older, { body: '9 up 1 down' });
    await t.vote(voters[0], lucky, 1).expect(200);
    for (const v of voters.slice(0, 9)) await t.vote(v, solid, 1).expect(200);
    await t.vote(voters[9], solid, -1).expect(200);

    const best = await thread(older, 'sort=best');
    expect(best.items.map((n) => n.commentId)).toEqual([solid, lucky]);
  });
});
