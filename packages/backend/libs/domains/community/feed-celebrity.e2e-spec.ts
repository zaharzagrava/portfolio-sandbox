import { TIMELINE_STORE, type TimelineStore } from './domain/ports';
import {
  createFeedApp,
  sortable,
  type FeedTestApp,
} from './testing/feed-fixtures';

/**
 * S26 US3: celebrity accounts are never fanned out; their recent items are merged into each follower's read
 * (AS-24..AS-30). The celebrity threshold is lowered to a handful of followers through the configuration service.
 */
describe('Follow feed: celebrity accounts merged at read time', () => {
  let t: FeedTestApp;

  beforeAll(async () => {
    t = await createFeedApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const minutesAgo = (m: number) => new Date(t.clock.nowMs() - m * 60_000);
  const ids = (page: { items: Array<{ itemId: string }> }) =>
    page.items.map((i) => i.itemId);
  const timelineStore = () =>
    t.app.get<TimelineStore>(TIMELINE_STORE, { strict: false });

  /** A shop followed by `followers` users, the first `active` of which have read the feed. */
  const shopWithFollowers = async (followers: number, active: number) => {
    const shop = await t.seedShop();
    const users = await t.users(followers);
    for (const [i, user] of users.entries()) {
      if (i < active) await t.activate(user, shop.accountId);
      else await t.follow(user, shop.accountId).expect(204);
    }
    return { shop, users };
  };

  describe('AS-24: a celebrity is never pushed', () => {
    it('S26 AS-24: fan-out reports celebrity with zero pushes, writes no follower timeline, and every follower sees the item once', async () => {
      t.config.set('feed_celebrity_threshold', 3);
      const { shop, users } = await shopWithFollowers(3, 2);
      const item = await t.newProductItem(shop, minutesAgo(5));
      const [announcement] = await t.announce();

      const result = await t.fanoutService().fanOut({
        itemId: announcement.payload.itemId,
        authorId: announcement.payload.authorId,
        kind: announcement.payload.kind,
        createdAt: announcement.payload.createdAt,
      });

      expect(result).toMatchObject({ celebrity: true, pushed: 0 });
      for (const user of users)
        expect(await t.redis.exists(`fd:tl:{${user.id}}`)).toBe(0);
      for (const user of users)
        expect(ids(await t.readPage(user))).toEqual([item.itemId]);
    });
  });

  describe('AS-25: a normal author pushes to active followers only', () => {
    it('S26 AS-25: below the threshold the item goes to the active follower only; both see it on their next read', async () => {
      t.config.set('feed_celebrity_threshold', 3);
      const { shop, users } = await shopWithFollowers(2, 1);
      const item = await t.newProductItem(shop, minutesAgo(5));
      const [announcement] = await t.announce();

      const result = await t.fanoutService().fanOut({
        itemId: announcement.payload.itemId,
        authorId: announcement.payload.authorId,
        kind: announcement.payload.kind,
        createdAt: announcement.payload.createdAt,
      });

      expect(result).toMatchObject({ celebrity: false, pushed: 1 });
      expect(await t.timeline(users[0])).toEqual([sortable(item.itemId)]);
      expect(await t.redis.exists(`fd:tl:{${users[1].id}}`)).toBe(0);
      for (const user of users)
        expect(ids(await t.readPage(user))).toEqual([item.itemId]);
    });
  });

  describe('AS-26: one merge of pushed entries and several celebrities', () => {
    it('S26 AS-26: the page is the global newest-first merge, ties by itemId descending, no duplicate when an item is both pushed and a recent', async () => {
      t.config.set('feed_celebrity_threshold', 2);
      const reader = (await t.users(1))[0];
      const other = (await t.users(1))[0];
      const c1 = await t.seedShop();
      const c2 = await t.seedShop();
      const n = await t.seedShop();
      await t.activate(reader, c1.accountId);
      await t.activate(reader, c2.accountId);
      await t.activate(reader, n.accountId);
      const base = t.clock.nowMs() - 3_600_000;
      const sameMs = new Date(base + 5_000);

      // pushed while C1 is still below the threshold: present as a pushed entry and, later, as a recent
      const early = await t.newProductItem(c1, new Date(base + 1_000));
      await t.publishAll();
      await t.follow(other, c1.accountId).expect(204);
      await t.follow(other, c2.accountId).expect(204); // both are celebrities now

      const items = [
        early,
        await t.newProductItem(c2, new Date(base + 2_000)),
        await t.newProductItem(n, new Date(base + 3_000)),
        await t.newProductItem(c1, new Date(base + 4_000)),
        await t.newProductItem(c2, sameMs),
        await t.newProductItem(c1, sameMs),
        await t.newProductItem(n, sameMs),
        await t.newProductItem(c2, new Date(base + 6_000)),
      ];
      await t.publishAll();

      const expected = items
        .map((i) => i.itemId)
        .sort((a, b) => (sortable(a) < sortable(b) ? 1 : -1));
      const page = await t.readPage(reader, { limit: 50 });
      expect(ids(page)).toEqual(expected);
      expect(page.degraded).toBeUndefined();
      // a cursor in the middle of the same-millisecond tie loses and repeats nothing
      const first = await t.readPage(reader, { limit: 4 });
      const second = await t.readPage(reader, {
        limit: 4,
        cursor: first.nextCursor!,
      });
      expect([...ids(first), ...ids(second)]).toEqual(expected);
    });
  });

  describe('AS-27: promotion racing a publish', () => {
    it('S26 AS-27: each follower sees I1 and I2 exactly once, over 20 fresh repetitions', async () => {
      t.config.set('feed_celebrity_threshold', 3);
      for (let rep = 0; rep < 20; rep++) {
        const { shop, users } = await shopWithFollowers(2, 2);
        const [third] = await t.users(1);
        const i1 = await t.newProductItem(shop, minutesAgo(10));
        await t.publishAll();

        const publishSecond = async () => {
          const i2 = await t.newProductItem(shop, minutesAgo(1));
          await t.publishAll();
          return i2;
        };
        const [i2] = await Promise.all([
          publishSecond(),
          t.follow(third, shop.accountId).expect(204),
        ]);

        for (const user of [...users, third]) {
          const page = await t.readPage(user);
          expect(ids(page)).toEqual([i2.itemId, i1.itemId]);
        }
      }
    }, 240_000);
  });

  describe('AS-28: the celebrity state survives the loss of Redis', () => {
    it('S26 AS-28: after wiping every fd: key C is still a celebrity, its recents are rebuilt from history, and its next item is not pushed', async () => {
      t.config.set('feed_celebrity_threshold', 2);
      const { shop, users } = await shopWithFollowers(2, 1);
      const created: Array<{ productId: string; itemId: string }> = [];
      for (let i = 0; i < 3; i++)
        created.push(await t.newProductItem(shop, minutesAgo(30 - i)));
      await t.publishAll();
      expect(await t.redis.exists(`fd:cel:{${shop.accountId}}`)).toBe(1);

      const keys = await t.redis.keys('fd:*');
      await t.redis.del(...keys);
      expect(await t.redis.keys('fd:*')).toEqual([]);

      const next = await t.newProductItem(shop, minutesAgo(1));
      const [announcement] = await t.announce();
      const result = await t.fanoutService().fanOut({
        itemId: announcement.payload.itemId,
        authorId: announcement.payload.authorId,
        kind: announcement.payload.kind,
        createdAt: announcement.payload.createdAt,
      });
      expect(result).toMatchObject({ celebrity: true, pushed: 0 });

      await t.redis.del(...(await t.redis.keys('fd:*')));
      const expected = [next, ...created.reverse()].map((i) => i.itemId);
      for (const user of users)
        expect(ids(await t.readPage(user))).toEqual(expected);
      expect(await t.redis.exists(`fd:cel:{${shop.accountId}}`)).toBe(1);
      for (const user of users)
        expect(await t.redis.exists(`fd:tl:{${user.id}}`)).toBe(0);
    });
  });

  describe('AS-29: the status is sticky', () => {
    it('S26 AS-29: a celebrity that lost followers down to 1 is still not fanned out', async () => {
      t.config.set('feed_celebrity_threshold', 3);
      const { shop, users } = await shopWithFollowers(3, 3);
      await t.unfollow(users[1], shop.accountId).expect(204);
      await t.unfollow(users[2], shop.accountId).expect(204);
      expect(
        (await t.followStatus(users[0], [shop.accountId]).expect(200)).body[0]
          .followerCount,
      ).toBe(1);

      const item = await t.newProductItem(shop, minutesAgo(1));
      const [announcement] = await t.announce();
      const result = await t.fanoutService().fanOut({
        itemId: announcement.payload.itemId,
        authorId: announcement.payload.authorId,
        kind: announcement.payload.kind,
        createdAt: announcement.payload.createdAt,
      });

      expect(result).toMatchObject({ celebrity: true, pushed: 0 });
      expect(await t.redis.exists(`fd:tl:{${users[0].id}}`)).toBe(0);
      expect(ids(await t.readPage(users[0]))).toEqual([item.itemId]);
    });
  });

  describe('AS-30: a celebrity read that times out', () => {
    it('S26 AS-30: 200 with degraded, the other sources intact and in order, and the next read without the fault has the missing items', async () => {
      t.config.set('feed_celebrity_threshold', 2);
      t.config.set('feed_celebrity_timeout_ms', 150);
      const reader = (await t.users(1))[0];
      const other = (await t.users(1))[0];
      const c1 = await t.seedShop();
      const c2 = await t.seedShop();
      const c3 = await t.seedShop();
      const n = await t.seedShop();
      for (const shop of [c1, c2, c3]) {
        await t.activate(reader, shop.accountId);
        await t.follow(other, shop.accountId).expect(204);
      }
      await t.activate(reader, n.accountId);
      const base = t.clock.nowMs() - 3_600_000;
      const mine = [
        await t.newProductItem(c1, new Date(base + 1_000)),
        await t.newProductItem(c3, new Date(base + 2_000)),
        await t.newProductItem(n, new Date(base + 3_000)),
        await t.newProductItem(c1, new Date(base + 4_000)),
      ];
      const hidden = [
        await t.newProductItem(c2, new Date(base + 2_500)),
        await t.newProductItem(c2, new Date(base + 5_000)),
      ];
      await t.publishAll();

      const timelines = timelineStore();
      const original = timelines.recents.bind(timelines);
      timelines.recents = async (author, before, limit) => {
        if (author === c2.accountId)
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        return original(author, before, limit);
      };
      let degradedPage;
      try {
        degradedPage = await t.readPage(reader, { limit: 50 });
      } finally {
        timelines.recents = original;
      }

      expect(degradedPage.degraded).toBe(true);
      expect(ids(degradedPage)).toEqual(
        mine
          .map((i) => i.itemId)
          .sort((a, b) => (sortable(a) < sortable(b) ? 1 : -1)),
      );

      const healthy = await t.readPage(reader, { limit: 50 });
      expect(healthy.degraded).toBeUndefined();
      expect(ids(healthy)).toEqual(
        [...mine, ...hidden]
          .map((i) => i.itemId)
          .sort((a, b) => (sortable(a) < sortable(b) ? 1 : -1)),
      );
    });
  });
});
