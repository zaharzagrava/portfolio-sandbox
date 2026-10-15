import {
  createDiscussionsApp,
  type DiscussionsTestApp,
} from './testing/discussions-fixtures';

describe('W02 B-4: DELETE /posts/:postId edge cases', () => {
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

  it('W02 B-4: no credentials is 401 and the post survives', async () => {
    const postId = await t.newPost(w.author, w.product.id);
    await t.http().delete(`/api/posts/${postId}`).expect(401);
    await t.http().get(`/api/posts/${postId}`).expect(200);
  });

  it('W02 B-4: a malformed id is 400', async () => {
    await t.as(w.author).delete('/api/posts/not-a-uuid').expect(400);
  });

  it('W02 B-4: author 204 twice and post_deleted recorded once', async () => {
    const postId = await t.newPost(w.author, w.product.id);
    await t.as(w.author).delete(`/api/posts/${postId}`).expect(204);
    await t.as(w.author).delete(`/api/posts/${postId}`).expect(204);
    const events = (await t.cql('SELECT * FROM recorded_events')).rows.filter(
      (e) => e.type === 'discussion.post_deleted',
    );
    expect(events).toHaveLength(1);
  });
});
