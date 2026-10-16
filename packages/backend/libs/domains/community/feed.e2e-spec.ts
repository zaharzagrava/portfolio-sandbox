import { createFeedApp, type FeedTestApp } from './testing/feed-fixtures';

/**
 * S26 end to end through the real stores: push to an active follower, pull for a celebrity, rebuild for an
 * inactive follower, and unfollow hiding delivered items. Successor of the first single-file feed spec; the
 * detailed variants live in feed-celebrity, feed-rebuild and feed-fanout.
 */
describe('Follow feed (e2e)', () => {
  let t: FeedTestApp;

  beforeAll(async () => {
    t = await createFeedApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const minutesAgo = (m: number) => new Date(t.clock.nowMs() - m * 60_000);
  const ids = (page: { items: Array<{ itemId: string }> }) =>
    page.items.map((i) => i.itemId);
  const fanOutLast = async () => {
    const [a] = await t.announce();
    return t.fanoutService().fanOut({
      itemId: a.payload.itemId,
      authorId: a.payload.authorId,
      kind: a.payload.kind,
      createdAt: a.payload.createdAt,
    });
  };

  it("S26 AS-25: push: an active follower sees a normal shop's new item via their timeline", async () => {
    const shop = await t.seedShop();
    const [reader] = await t.users(1);
    await t.activate(reader, shop.accountId);
    const item = await t.newProductItem(shop, minutesAgo(1));

    const result = await fanOutLast();

    expect(result).toMatchObject({ celebrity: false, pushed: 1 });
    expect(ids(await t.readPage(reader))).toEqual([item.itemId]);
  });

  it('S26 AS-24: pull: celebrity items are not fanned out but merged in at read time', async () => {
    t.config.set('feed_celebrity_threshold', 1);
    const shop = await t.seedShop();
    const [reader] = await t.users(1);
    await t.activate(reader, shop.accountId);
    const item = await t.newProductItem(shop, minutesAgo(1));

    const result = await fanOutLast();

    expect(result).toMatchObject({ celebrity: true, pushed: 0 });
    expect(await t.redis.exists(`fd:tl:{${reader.id}}`)).toBe(0);
    expect(ids(await t.readPage(reader))).toEqual([item.itemId]);
  });

  it('S26 AS-32: inactive followers get nothing pushed; on return their timeline is rebuilt, newest first', async () => {
    const [a, b] = [await t.seedShop(), await t.seedShop()];
    const [reader] = await t.users(1);
    await t.follow(reader, a.accountId).expect(204);
    await t.follow(reader, b.accountId).expect(204);
    const first = await t.newProductItem(a, minutesAgo(10));
    expect((await fanOutLast()).pushed).toBe(0);
    const second = await t.newProductItem(b, minutesAgo(5));
    expect((await fanOutLast()).pushed).toBe(0);
    expect(await t.redis.exists(`fd:tl:{${reader.id}}`)).toBe(0);

    expect(ids(await t.readPage(reader))).toEqual([
      second.itemId,
      first.itemId,
    ]);
  });

  it('S26 AS-36: unfollow hides already-delivered items on the very next read', async () => {
    const shop = await t.seedShop();
    const [reader] = await t.users(1);
    await t.activate(reader, shop.accountId);
    const item = await t.newProductItem(shop, minutesAgo(1));
    await fanOutLast();
    expect(ids(await t.readPage(reader))).toEqual([item.itemId]);

    await t.unfollow(reader, shop.accountId).expect(204);

    expect(ids(await t.readPage(reader))).toEqual([]);
  });
});
