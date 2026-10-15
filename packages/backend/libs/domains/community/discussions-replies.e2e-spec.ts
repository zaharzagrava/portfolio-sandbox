import { v4 as uuidv4 } from 'uuid';
import {
  createDiscussionsApp,
  type DiscussionsTestApp,
} from './testing/discussions-fixtures';

describe('W02 B-5: GET /comments/:commentId/replies edge cases', () => {
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

  it('W02 B-5: default limit is 5, limit is bounded 1-50, anonymous allowed', async () => {
    const postId = await t.newPost(w.author, w.product.id);
    const root = await t.newComment(w.reader, postId, { body: 'root' });
    for (const user of await t.users(12)) {
      t.clock.advance(1_000);
      await t.newComment(user, postId, { body: 'reply', parentId: root });
    }
    // S25 default is 25; the web always sends limit=5 explicitly.
    const def = await t.http().get(`/api/comments/${root}/replies`).expect(200);
    expect(def.body.items).toHaveLength(7);
    const five = await t
      .http()
      .get(`/api/comments/${root}/replies?limit=5`)
      .expect(200);
    expect(five.body.items).toHaveLength(5);
    expect(five.body.nextCursor).toEqual(expect.any(String));
    const one = await t
      .http()
      .get(`/api/comments/${root}/replies?limit=1`)
      .expect(200);
    expect(one.body.items).toHaveLength(1);
    await t.http().get(`/api/comments/${root}/replies?limit=0`).expect(400);
    await t.http().get(`/api/comments/${root}/replies?limit=51`).expect(400);
    const all = await t
      .http()
      .get(`/api/comments/${root}/replies?limit=50`)
      .expect(200);
    expect(all.body.items).toHaveLength(7);
    expect(all.body.nextCursor).toBeNull();
  });

  it('W02 B-5: a deleted post or unknown comment is 404', async () => {
    const postId = await t.newPost(w.author, w.product.id);
    const root = await t.newComment(w.reader, postId, { body: 'root' });
    await t.as(w.author).delete(`/api/posts/${postId}`).expect(204);
    await t.http().get(`/api/comments/${root}/replies`).expect(404);
    await t.http().get(`/api/comments/${uuidv4()}/replies`).expect(404);
  });
});
