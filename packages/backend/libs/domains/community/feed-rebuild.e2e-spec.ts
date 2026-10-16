import {
  FEED_ITEM_STORE,
  type AuthorHistoryEntry,
  type FeedItemStore,
} from './domain/ports';
import {
  createFeedApp,
  sortable,
  type FeedTestApp,
} from './testing/feed-fixtures';

/**
 * S26 US4: a reader who was away, or whose timeline was lost, gets it rebuilt from the durable per-author history on the
 * next read (AS-32..AS-37). History reads are observed and slowed at the item store edge.
 */
describe('Follow feed: inactive users and rebuild on return', () => {
  let t: FeedTestApp;

  beforeAll(async () => {
    t = await createFeedApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const DAY = 86_400_000;
  const minutesAgo = (m: number) => new Date(t.clock.nowMs() - m * 60_000);
  const ids = (page: { items: Array<{ itemId: string }> }) =>
    page.items.map((i) => i.itemId);
  const newestFirst = (list: string[]) =>
    [...list].sort((a, b) => (sortable(a) < sortable(b) ? 1 : -1));
  const itemStore = () =>
    t.app.get<FeedItemStore>(FEED_ITEM_STORE, { strict: false });

  /** Wraps `authorHistory` of the item store for the duration of `body`. */
  const withHistory = async <T>(
    wrap: (
      original: FeedItemStore['authorHistory'],
    ) => FeedItemStore['authorHistory'],
    body: () => Promise<T>,
  ): Promise<T> => {
    const store = itemStore();
    const original = store.authorHistory.bind(store);
    store.authorHistory = wrap(original);
    try {
      return await body();
    } finally {
      store.authorHistory = original;
    }
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  describe('AS-32: an inactive reader receives no pushes and gets a rebuild on return', () => {
    it('S26 AS-32: no write for R while away; the read returns both items newest first, makes R active (7-day marker), and the next item is pushed', async () => {
      const [reader] = await t.users(1);
      const a = await t.seedShop();
      const b = await t.seedShop();
      await t.follow(reader, a.accountId).expect(204);
      await t.follow(reader, b.accountId).expect(204);
      // R has not read the feed for 8 days: the active marker is a Redis key with a wall-clock expiry, so "away" is the
      // absence of the marker (R never read); moving the frozen clock would only expire R's access token
      expect(await t.redis.exists(`fd:act:{${reader.id}}`)).toBe(0);

      const ia = await t.newProductItem(a, minutesAgo(20));
      const ib = await t.newProductItem(b, minutesAgo(10));
      const announced = await t.announce();
      for (const announcement of announced) {
        const result = await t.fanoutService().fanOut({
          itemId: announcement.payload.itemId,
          authorId: announcement.payload.authorId,
          kind: announcement.payload.kind,
          createdAt: announcement.payload.createdAt,
        });
        expect(result.pushed).toBe(0);
      }
      expect(await t.redis.exists(`fd:tl:{${reader.id}}`)).toBe(0);

      const page = await t.readPage(reader);
      expect(ids(page)).toEqual([ib.itemId, ia.itemId]);
      const ttl = await t.redis.ttl(`fd:act:{${reader.id}}`);
      expect(ttl).toBeGreaterThan(7 * 86_400 - 60);
      expect(ttl).toBeLessThanOrEqual(7 * 86_400);

      const next = await t.newProductItem(a, minutesAgo(1));
      await t.publishAll();
      expect(await t.timeline(reader)).toEqual(
        newestFirst([ia.itemId, ib.itemId, next.itemId]).map(sortable),
      );
    });
  });

  describe('AS-33: a lost timeline is rebuilt', () => {
    it('S26 AS-33: with the list removed and the active marker present the read rebuilds up to 50 items per author from the last 60 days, and R stays active', async () => {
      const [reader] = await t.users(1);
      const a = await t.seedShop();
      const b = await t.seedShop();
      await t.activate(reader, a.accountId);
      await t.activate(reader, b.accountId);
      const base = t.clock.nowMs();
      const fromA: string[] = [];
      for (let i = 0; i < 52; i++)
        fromA.push(
          (await t.newProductItem(a, new Date(base - (i + 1) * 60_000))).itemId,
        );
      const oldB = await t.newProductItem(b, new Date(base - 70 * DAY));
      const recentB = await t.newProductItem(b, new Date(base - 30 * DAY));
      await t.publishAll();
      await t.redis.del(`fd:tl:{${reader.id}}`);
      expect(await t.redis.exists(`fd:act:{${reader.id}}`)).toBe(1);

      const page = await t.readPage(reader, { limit: 50 });

      expect(page.items).toHaveLength(50);
      const timeline = await t.timeline(reader);
      // 50 newest of A (the 51st and 52nd are cut), B's item inside 60 days; B's 70 day old item is not rebuilt
      expect(timeline).toHaveLength(51);
      expect(timeline).toContain(sortable(recentB.itemId));
      expect(timeline).not.toContain(sortable(oldB.itemId));
      expect(timeline).toEqual(
        expect.arrayContaining(fromA.slice(0, 50).map(sortable)),
      );
      expect(timeline).not.toContain(sortable(fromA[51]));
      expect(await t.redis.exists(`fd:act:{${reader.id}}`)).toBe(1);
      expect(await t.redis.exists(`fd:tlc:{${reader.id}}`)).toBe(1);
    });
  });

  describe('AS-34: concurrent first reads', () => {
    it('S26 AS-34: 10 concurrent reads of an inactive reader are identical, each item once, and the stored timeline has each item once', async () => {
      const [reader] = await t.users(1);
      const shops = await Promise.all([1, 2, 3, 4, 5].map(() => t.seedShop()));
      const created: string[] = [];
      for (const [i, shop] of shops.entries()) {
        await t.follow(reader, shop.accountId).expect(204);
        created.push((await t.newProductItem(shop, minutesAgo(50 - i))).itemId);
      }
      await t.publishAll();
      expect(await t.redis.exists(`fd:tl:{${reader.id}}`)).toBe(0);

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => t.feed(reader)),
      );

      for (const res of responses) expect(res.status).toBe(200);
      const first = JSON.stringify(responses[0].body);
      for (const res of responses) expect(JSON.stringify(res.body)).toBe(first);
      expect(responses[0].body.items.map((i: any) => i.itemId)).toEqual(
        newestFirst(created),
      );
      expect(responses[0].body.degraded).toBeUndefined();
      expect(await t.timeline(reader)).toEqual(
        newestFirst(created).map(sortable),
      );
    });
  });

  describe('AS-35: a push during a rebuild', () => {
    it('S26 AS-35: an item pushed while the rebuild is reading is neither lost nor duplicated, over 20 fresh repetitions', async () => {
      for (let rep = 0; rep < 20; rep++) {
        const [reader] = await t.users(1);
        const shop = await t.seedShop();
        await t.activate(reader, shop.accountId);
        const x1 = await t.newProductItem(shop, minutesAgo(30));
        await t.publishAll();
        await t.redis.del(`fd:tl:{${reader.id}}`);

        // the rebuild takes its snapshot of the history, then lingers; the push lands in that window
        let snapshotTaken: () => void = () => undefined;
        const taken = new Promise<void>((r) => (snapshotTaken = r));
        const x2Pushed = await withHistory(
          (original) => async (author, before, notBefore, limit, now) => {
            const entries: AuthorHistoryEntry[] = await original(
              author,
              before,
              notBefore,
              limit,
              now,
            );
            snapshotTaken();
            await sleep(120);
            return entries;
          },
          async () => {
            const read = t.feed(reader).then((res) => res);
            await taken;
            const x2 = await t.newProductItem(shop, minutesAgo(1));
            await t.publishAll();
            const first = await read;
            expect(first.status).toBe(200);
            return x2;
          },
        );

        const page = await t.readPage(reader);
        expect(ids(page)).toEqual([x2Pushed.itemId, x1.itemId]);
        expect(await t.timeline(reader)).toEqual([
          sortable(x2Pushed.itemId),
          sortable(x1.itemId),
        ]);
      }
    }, 240_000);
  });

  describe('AS-36: follow and unfollow', () => {
    it('S26 AS-36: following shows the recent items, unfollowing hides them on the very next read, following again shows them', async () => {
      const [reader] = await t.users(1);
      const mine = await t.seedShop();
      const x = await t.seedShop();
      await t.activate(reader, mine.accountId);
      const old = [
        await t.newProductItem(x, minutesAgo(3 * 60 * 24)),
        await t.newProductItem(x, minutesAgo(2 * 60 * 24)),
        await t.newProductItem(x, minutesAgo(60 * 24)),
      ].map((i) => i.itemId);
      await t.publishAll();
      expect(ids(await t.readPage(reader))).toEqual([]);

      await t.follow(reader, x.accountId).expect(204);
      expect(ids(await t.readPage(reader))).toEqual(newestFirst(old));
      expect((await t.timeline(reader)).length).toBe(3);

      await t.unfollow(reader, x.accountId).expect(204);
      expect(ids(await t.readPage(reader))).toEqual([]);

      await t.follow(reader, x.accountId).expect(204);
      expect(ids(await t.readPage(reader))).toEqual(newestFirst(old));
    });
  });

  describe('AS-37: bounded and time-bounded rebuild', () => {
    it('S26 AS-37: at most 16 history reads are in flight; one author timing out gives a degraded page, no completion marker, and the next read retries', async () => {
      const [reader] = await t.users(1);
      const shops = await Promise.all(
        Array.from({ length: 30 }, () => t.seedShop()),
      );
      const created: Array<{ author: string; itemId: string }> = [];
      for (const [i, shop] of shops.entries()) {
        await t.follow(reader, shop.accountId).expect(204);
        created.push({
          author: shop.accountId,
          itemId: (await t.newProductItem(shop, minutesAgo(100 - i))).itemId,
        });
      }
      await t.publishAll();
      t.config.set('feed_history_timeout_ms', 300);

      let inFlight = 0;
      let maxInFlight = 0;
      await withHistory(
        (original) => async (author, before, notBefore, limit, now) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await sleep(30);
            return await original(author, before, notBefore, limit, now);
          } finally {
            inFlight--;
          }
        },
        async () => {
          const page = await t.readPage(reader, { limit: 50 });
          expect(ids(page)).toEqual(newestFirst(created.map((c) => c.itemId)));
        },
      );
      expect(maxInFlight).toBeGreaterThan(1);
      expect(maxInFlight).toBeLessThanOrEqual(16);

      // a second reader: one author's history times out
      const [second] = await t.users(1);
      for (const shop of shops)
        await t.follow(second, shop.accountId).expect(204);
      const slow = created[7];
      const degraded = await withHistory(
        (original) => async (author, before, notBefore, limit, now) => {
          if (author === slow.author) await sleep(2_000);
          return original(author, before, notBefore, limit, now);
        },
        () => t.readPage(second, { limit: 50 }),
      );
      expect(degraded.degraded).toBe(true);
      expect(ids(degraded)).toEqual(
        newestFirst(created.filter((c) => c !== slow).map((c) => c.itemId)),
      );
      expect(await t.redis.exists(`fd:tlc:{${second.id}}`)).toBe(0);

      const retried = await t.readPage(second, { limit: 50 });
      expect(retried.degraded).toBeUndefined();
      expect(ids(retried)).toEqual(newestFirst(created.map((c) => c.itemId)));
      expect(await t.redis.exists(`fd:tlc:{${second.id}}`)).toBe(1);
    }, 120_000);
  });
});
