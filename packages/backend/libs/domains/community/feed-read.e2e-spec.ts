import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { feedPageSchema, type FeedPage } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ShopQueryService } from '@app/domains/tenancy';
import { DiscussionQueryService } from './application/discussion-query.service';
import {
  FEED_ITEM_STORE,
  PRODUCT_COPY_STORE,
  type FeedItemStore,
  type ProductCopyStore,
} from './domain/ports';
import {
  FeedAuctionsProjector,
  FeedProductsProjector,
} from './infra/feed-projectors';
import {
  createFeedApp,
  sortable,
  type FeedTestApp,
  type PublishedEvent,
  type TestUser,
} from './testing/feed-fixtures';

/**
 * S26 US2 (read half): the home timeline (AS-18..AS-21, AS-23, AS-43). Items are made by the real consumers, announced by
 * the real relay and pushed by the real fan-out consumer; the page is read through HTTP and parsed with the contract
 * schema. Later phases extend this file with the hydration and degradation scenarios.
 */
describe('Follow feed: home timeline, paging, hydration and degradation', () => {
  let t: FeedTestApp;
  const products = () => t.projector(FeedProductsProjector);
  const auctions = () => t.projector(FeedAuctionsProjector);

  beforeAll(async () => {
    t = await createFeedApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  // ---- helpers ---------------------------------------------------------------------------------------------------
  const claimed = async (kind: string, key: string) =>
    (
      await t.cql(
        'SELECT item_id FROM item_claims WHERE kind = ? AND source_key = ?',
        [kind, key],
      )
    )
      .first()
      ?.item_id.toString() as string;

  /** A product item created at `at`; returns the item id. */
  const newProduct = async (
    shop: { shopId: string },
    at: Date,
    options: { title?: string; priceMinor?: number } = {},
  ) => {
    const productId = uuidv4();
    await products().project([
      t.productEvent('created', {
        productId,
        shopId: shop.shopId,
        occurredAt: at,
        ...options,
      }),
    ]);
    return { productId, itemId: await claimed('new_product', productId) };
  };

  /** Relays every pending announcement and fans them out in creation order. */
  const publishAll = async (): Promise<Map<string, PublishedEvent>> => {
    const announced = (await t.announce()).sort((a, b) =>
      sortable(a.payload.itemId) < sortable(b.payload.itemId) ? -1 : 1,
    );
    await t.fanOut(announced);
    return new Map(announced.map((a) => [a.payload.itemId as string, a]));
  };

  const activate = async (user: TestUser, accountId: string) => {
    await t.follow(user, accountId).expect(204);
    await t.feed(user).expect(200);
  };
  const read = async (
    user: TestUser,
    query: Record<string, string | number> = {},
  ): Promise<FeedPage> =>
    feedPageSchema.parse((await t.feed(user, query).expect(200)).body);
  const ids = (p: FeedPage) => p.items.map((i) => i.itemId);
  const timeline = (user: TestUser) =>
    t.redis.zrevrange(`fd:tl:{${user.id}}`, 0, -1);

  const minutesAgo = (m: number) => new Date(t.clock.nowMs() - m * 60_000);

  describe('AS-18: pushes arriving out of order', () => {
    it('S26 AS-18: pairs pushed in either order are returned newest first', async () => {
      const [reader] = await t.users(1);
      const s1 = await t.seedShop();
      const s2 = await t.seedShop();
      await activate(reader, s1.accountId);
      await activate(reader, s2.accountId);
      const base = t.clock.nowMs() - 3_600_000;
      const a1 = await newProduct(s1, new Date(base + 4_000));
      const b1 = await newProduct(s1, new Date(base + 3_000));
      const a2 = await newProduct(s2, new Date(base + 2_000));
      const b2 = await newProduct(s2, new Date(base + 1_000));
      const announced = new Map(
        (await t.announce()).map((a) => [a.payload.itemId as string, a]),
      );

      // the first pair is pushed 2000 then 1000, the second pair the other way round
      await t.fanOut([announced.get(a1.itemId)!, announced.get(b1.itemId)!]);
      await t.fanOut([announced.get(b2.itemId)!, announced.get(a2.itemId)!]);

      const expected = [a1, b1, a2, b2].map((i) => i.itemId);
      expect(await timeline(reader)).toEqual(expected.map(sortable));
      expect(ids(await read(reader))).toEqual(expected);
    });

    it('S26 AS-18: items in the same millisecond are ordered by itemId, descending, on every read and whatever the push order', async () => {
      const [reader] = await t.users(1);
      const s1 = await t.seedShop();
      const s2 = await t.seedShop();
      await activate(reader, s1.accountId);
      await activate(reader, s2.accountId);
      const base = t.clock.nowMs() - 3_600_000;
      const same1 = new Date(base + 2_000);
      const same2 = new Date(base + 1_000);
      const x1 = await newProduct(s1, same1);
      const y1 = await newProduct(s1, same1);
      const x2 = await newProduct(s2, same2);
      const y2 = await newProduct(s2, same2);
      expect(sortable(y1.itemId) > sortable(x1.itemId)).toBe(true);
      expect(sortable(y2.itemId) > sortable(x2.itemId)).toBe(true);
      const announced = new Map(
        (await t.announce()).map((a) => [a.payload.itemId as string, a]),
      );

      await t.fanOut([announced.get(x1.itemId)!, announced.get(y1.itemId)!]);
      await t.fanOut([announced.get(y2.itemId)!, announced.get(x2.itemId)!]);

      const expected = [y1, x1, y2, x2].map((i) => i.itemId);
      expect(await timeline(reader)).toEqual(expected.map(sortable));
      expect(ids(await read(reader))).toEqual(expected);
      expect(ids(await read(reader))).toEqual(expected);
    });
  });

  describe('AS-19: cursor paging', () => {
    it('S26 AS-19: three pages of 4 over 12 items with window 5, without gap or repeat, while new items arrive; the last cursor is null', async () => {
      t.config.set('feed_timeline_window', 5);
      const [reader] = await t.users(1);
      const shop = await t.seedShop();
      await activate(reader, shop.accountId);
      const created: string[] = [];
      for (let i = 0; i < 12; i++) {
        created.push((await newProduct(shop, minutesAgo(120 - i * 5))).itemId);
        await publishAll();
      }
      const newestFirst = [...created].reverse();
      expect(await t.redis.zcard(`fd:tl:{${reader.id}}`)).toBe(5);

      const first = await read(reader, { limit: 4 });
      expect(ids(first)).toEqual(newestFirst.slice(0, 4));
      expect(first.nextCursor).toEqual(expect.any(String));

      // a new item arrives between page requests: it never shifts or repeats the later pages
      await newProduct(shop, minutesAgo(1));
      await publishAll();

      const second = await read(reader, {
        limit: 4,
        cursor: first.nextCursor!,
      });
      expect(ids(second)).toEqual(newestFirst.slice(4, 8));
      expect(second.nextCursor).toEqual(expect.any(String));

      const third = await read(reader, {
        limit: 4,
        cursor: second.nextCursor!,
      });
      expect(ids(third)).toEqual(newestFirst.slice(8, 12));
      expect(third.nextCursor).toBeNull();
    });
  });

  describe('AS-20: validation', () => {
    it.each([
      ['limit 0', { limit: 0 }, 'validation_failed'],
      ['limit 51', { limit: 51 }, 'validation_failed'],
      ['limit abc', { limit: 'abc' }, 'validation_failed'],
      ['an unknown parameter', { before: '123' }, 'validation_failed'],
      ['a malformed cursor', { cursor: 'garbage' }, 'invalid_cursor'],
    ])('S26 AS-20: %s is 400', async (_label, query, code) => {
      const [reader] = await t.users(1);
      const res = await t.feed(reader, query as never).expect(400);
      expect(res.body.code).toBe(code);
      expect(res.headers['content-type']).toContain('problem+json');
    });

    it('S26 AS-20: an edited cursor and a cursor of the following list are invalid_cursor', async () => {
      const [reader] = await t.users(1);
      const shop = await t.seedShop();
      const other = await t.seedShop();
      await t.follow(reader, shop.accountId).expect(204);
      await t.follow(reader, other.accountId).expect(204);
      await newProduct(shop, minutesAgo(10));
      await newProduct(shop, minutesAgo(5));
      const first = await read(reader, { limit: 1 });
      const cursor = first.nextCursor!;
      expect(cursor).toBeTruthy();

      const edited = `${cursor.slice(0, 2)}${cursor[2] === 'A' ? 'B' : 'A'}${cursor.slice(3)}`;
      for (const bad of [edited, `${cursor}x`]) {
        const res = await t.feed(reader, { cursor: bad }).expect(400);
        expect(res.body.code).toBe('invalid_cursor');
      }
      const following = (await t.following(reader, { limit: 1 }).expect(200))
        .body.nextCursor as string;
      const res = await t.feed(reader, { cursor: following }).expect(400);
      expect(res.body.code).toBe('invalid_cursor');
    });

    it('S26 AS-20: the default limit is 30 and the maximum 50', async () => {
      const [reader] = await t.users(1);
      const shop = await t.seedShop();
      await t.follow(reader, shop.accountId).expect(204);
      for (let i = 0; i < 31; i++) await newProduct(shop, minutesAgo(100 - i));

      const byDefault = await read(reader);
      expect(byDefault.items).toHaveLength(30);
      expect(byDefault.nextCursor).toEqual(expect.any(String));
      const max = await read(reader, { limit: 50 });
      expect(max.items).toHaveLength(31);
      expect(max.nextCursor).toBeNull();
    });
  });

  describe('AS-21: empty feed', () => {
    it('S26 AS-21: a buyer who follows no one, and one who follows a shop without items, get an empty page', async () => {
      const [lonely, reader] = await t.users(2);
      const shop = await t.seedShop();
      await t.follow(reader, shop.accountId).expect(204);

      expect((await t.feed(lonely).expect(200)).body).toEqual({
        items: [],
        nextCursor: null,
      });
      expect((await t.feed(reader).expect(200)).body).toEqual({
        items: [],
        nextCursor: null,
      });
    });
  });

  describe('AS-23: retention', () => {
    it('S26 AS-23: items older than 90 days are not served, from the timeline or from history, and everything stored expires', async () => {
      t.config.set('feed_timeline_window', 800);
      const [reader] = await t.users(1);
      const shop = await t.seedShop();
      await activate(reader, shop.accountId);
      const day = 86_400_000;
      const old = await newProduct(shop, new Date(t.clock.nowMs() - 100 * day));
      const edge = await newProduct(shop, new Date(t.clock.nowMs() - 91 * day));
      const recent = await newProduct(
        shop,
        new Date(t.clock.nowMs() - 10 * day),
      );
      await publishAll(); // the old ones are pushed too: the read must still refuse them

      const everything: string[] = [];
      let cursor: string | undefined;
      do {
        const p = await read(
          reader,
          cursor ? { limit: 1, cursor } : { limit: 1 },
        );
        everything.push(...ids(p));
        cursor = p.nextCursor ?? undefined;
      } while (cursor);

      expect(everything).toEqual([recent.itemId]);
      for (const item of [old, edge, recent]) {
        const row = (
          await t.cql(
            'SELECT TTL(title) AS ttl FROM feed_items WHERE item_id = ?',
            [item.itemId],
          )
        ).first()!;
        expect(row.ttl).toBeGreaterThan(0);
        expect(row.ttl).toBeLessThanOrEqual(7_776_000);
      }
    });
  });

  describe('AS-43: shapes', () => {
    it('S26 AS-43: every kind parses with the contract schema with exactly the listed fields, integer money, shop name or null', async () => {
      const [reader, author] = await t.users(2);
      const shop = await t.seedShop({ name: 'Shape Shop' });
      await t.follow(reader, shop.accountId).expect(204);
      await t.follow(reader, `user:${author.id}`).expect(204);
      const productId = uuidv4();
      const auctionId = uuidv4();
      const startsAt = new Date(t.clock.nowMs() + 3_600_000);
      const endsAt = new Date(t.clock.nowMs() + 90_000_000);
      await products().project([
        t.productEvent('created', {
          productId,
          shopId: shop.shopId,
          priceMinor: 12_900,
          occurredAt: minutesAgo(50),
        }),
        t.productEvent('updated', {
          productId,
          shopId: shop.shopId,
          priceMinor: 9_900,
          productVersion: 2,
          changedFields: ['priceMinor'],
          occurredAt: minutesAgo(40),
        }),
      ]);
      await auctions().project([
        t.auctionCreated({
          auctionId,
          shopId: shop.shopId,
          productId,
          startsAt,
          endsAt,
          // an event time of its own
        }),
        t.auctionOpened({ auctionId, shopId: shop.shopId, productId, endsAt }),
      ]);
      // a real S25 post: the feed shows a post only while S25's batch query still returns it
      const { postId, boardId } = await t.newPostItem({
        authorId: author.id,
        at: minutesAgo(5),
        title: 'My post',
      });

      const res = await t.feed(reader, { limit: 50 }).expect(200);
      const page = feedPageSchema.parse(res.body);
      const byKind = new Map(page.items.map((i) => [i.kind, i]));
      expect([...byKind.keys()].sort()).toEqual([
        'auction_started',
        'drop_announced',
        'new_product',
        'post',
        'price_drop',
      ]);
      expect(page.items).toHaveLength(5);
      expect(Object.keys(res.body).sort()).toEqual(['items', 'nextCursor']);
      for (const item of res.body.items as Array<Record<string, any>>) {
        expect(Object.keys(item).sort()).toEqual([
          'author',
          'createdAt',
          'itemId',
          'kind',
          'payload',
          'title',
        ]);
        expect(Object.keys(item.author).sort()).toEqual([
          'accountId',
          'name',
          'type',
        ]);
        expect(item.createdAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
      }
      expect(byKind.get('new_product')!.payload).toEqual({
        productId,
        priceMinor: 12_900,
        currency: 'USD',
      });
      expect(byKind.get('price_drop')!.payload).toEqual({
        productId,
        previousPriceMinor: 12_900,
        priceMinor: 9_900,
        currency: 'USD',
      });
      expect(byKind.get('post')!.payload).toEqual({ postId, boardId });
      expect(byKind.get('drop_announced')!.payload).toEqual({
        auctionId,
        productId,
        startsAt: startsAt.toISOString(),
      });
      expect(byKind.get('auction_started')!.payload).toEqual({
        auctionId,
        productId,
        endsAt: endsAt.toISOString(),
      });
      expect(byKind.get('new_product')!.author).toEqual({
        accountId: shop.accountId,
        type: 'shop',
        name: 'Shape Shop',
      });
      expect(byKind.get('post')!.author).toEqual({
        accountId: `user:${author.id}`,
        type: 'user',
        name: null,
      });
      for (const item of page.items)
        for (const value of Object.values(item.payload))
          if (typeof value === 'number')
            expect(Number.isInteger(value)).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(
        /item_id|product_id|shop_id|post_id|month|bucket/,
      );
    });
  });

  // ---- US5: hidden and unavailable content ------------------------------------------------------------------------
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const newest = (list: string[]) =>
    [...list].sort((a, b) => (sortable(a) < sortable(b) ? 1 : -1));

  /** Replaces `method` of `target` by a copy that records its arguments and waits `ms` first. */
  const instrument = <T extends object>(
    target: T,
    method: keyof T & string,
    ms = 0,
  ) => {
    const original = target[method] as unknown as (...a: unknown[]) => unknown;
    const calls: unknown[][] = [];
    (target as Record<string, unknown>)[method] = async (
      ...args: unknown[]
    ) => {
      calls.push(args);
      if (ms) await sleep(ms);
      return original.apply(target, args);
    };
    return {
      calls,
      restore: () => ((target as Record<string, unknown>)[method] = original),
    };
  };

  const archive = (
    shop: { shopId: string },
    productId: string,
    productVersion: number,
  ) =>
    products().project([
      t.productEvent('archived', {
        productId,
        shopId: shop.shopId,
        status: 'ARCHIVED',
        productVersion,
      }),
    ]);

  describe('AS-38: hidden content', () => {
    it('S26 AS-38: a deleted post, an archived, restored, deleted or sandbox product and a closed shop are hidden, and come back when they do', async () => {
      const [reader, author] = await t.users(2);
      const shop = await t.seedShop();
      await t.follow(reader, shop.accountId).expect(204);
      await t.follow(reader, `user:${author.id}`).expect(204);
      const post = await t.newPostItem({
        authorId: author.id,
        at: minutesAgo(30),
      });
      const p1 = await newProduct(shop, minutesAgo(20));
      const p2 = await newProduct(shop, minutesAgo(10));
      await publishAll();
      const visible = async () => ids(await read(reader, { limit: 50 }));
      expect(await visible()).toEqual([p2.itemId, p1.itemId, post.itemId]);

      // the post: S25's batch query no longer returns it; no consumer lag is needed
      await t.deletePost(post.postId);
      expect(await visible()).toEqual([p2.itemId, p1.itemId]);

      // archived, restored, deleted; a restore with a lower version changes nothing
      await archive(shop, p1.productId, 2);
      expect(await visible()).toEqual([p2.itemId]);
      await products().project([
        t.productEvent('restored', {
          productId: p1.productId,
          shopId: shop.shopId,
          productVersion: 3,
        }),
      ]);
      expect(await visible()).toEqual([p2.itemId, p1.itemId]);
      await products().project([
        t.productDeleted({
          productId: p1.productId,
          shopId: shop.shopId,
          productVersion: 4,
        }),
      ]);
      expect(await visible()).toEqual([p2.itemId]);
      await products().project([
        t.productEvent('restored', {
          productId: p1.productId,
          shopId: shop.shopId,
          productVersion: 3,
        }),
      ]);
      expect(await visible()).toEqual([p2.itemId]);

      // sandbox
      await products().project([
        t.productEvent('updated', {
          productId: p2.productId,
          shopId: shop.shopId,
          isSandbox: true,
          productVersion: 2,
        }),
      ]);
      expect(await visible()).toEqual([]);
      await products().project([
        t.productEvent('updated', {
          productId: p2.productId,
          shopId: shop.shopId,
          isSandbox: false,
          productVersion: 3,
        }),
      ]);
      expect(await visible()).toEqual([p2.itemId]);

      // the shop
      for (const status of ['SUSPENDED', 'DELETING', 'DELETED'] as const) {
        t.setShopStatus(shop.shopId, status);
        expect(await visible()).toEqual([]);
        t.setShopStatus(shop.shopId, null);
        expect(await visible()).toEqual([p2.itemId]);
      }
    });
  });

  describe('AS-39: the page is filled', () => {
    const seed = async (count: number, hide: number[]) => {
      const [reader] = await t.users(1);
      const shop = await t.seedShop();
      await activate(reader, shop.accountId);
      const created: Array<{ productId: string; itemId: string }> = [];
      for (let i = 0; i < count; i++)
        created.push(await newProduct(shop, minutesAgo(200 - i * 5)));
      await publishAll();
      const newestFirst = [...created].reverse();
      for (const index of hide)
        await archive(shop, newestFirst[index].productId, 2);
      return { reader, newestFirst };
    };

    it('S26 AS-39: hidden items are replaced by older candidates; the cursor is null when candidates run out', async () => {
      const { reader, newestFirst } = await seed(6, [1, 3]);
      const page = await read(reader, { limit: 4 });
      expect(ids(page)).toEqual([0, 2, 4, 5].map((i) => newestFirst[i].itemId));
      expect(page.nextCursor).toBeNull();
    });

    it('S26 AS-39: the cursor is non-null while further candidates exist', async () => {
      const { reader, newestFirst } = await seed(7, [1, 3]);
      const first = await read(reader, { limit: 4 });
      expect(ids(first)).toEqual(
        [0, 2, 4, 5].map((i) => newestFirst[i].itemId),
      );
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await read(reader, {
        limit: 4,
        cursor: first.nextCursor!,
      });
      expect(ids(second)).toEqual([newestFirst[6].itemId]);
      expect(second.nextCursor).toBeNull();
    });

    it('S26 AS-39: at the scan bound (5 x limit) an unfilled page still carries a cursor, and the client can continue', async () => {
      const { reader, newestFirst } = await seed(
        15,
        Array.from({ length: 12 }, (_, i) => i),
      );
      const first = await read(reader, { limit: 2 });
      expect(first.items).toEqual([]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const seen: string[] = [];
      let cursor: string | null = first.nextCursor;
      while (cursor) {
        const page = await read(reader, { limit: 2, cursor });
        seen.push(...ids(page));
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(newestFirst.slice(12).map((i) => i.itemId));
    });
  });

  describe('AS-40: batched hydration', () => {
    it('S26 AS-40: 30 items cost one items read, one product copy read, one shop lookup and one post lookup, run in parallel', async () => {
      t.config.set('feed_directory_timeout_ms', 3_000);
      t.config.set('feed_hydration_timeout_ms', 3_000);
      const [reader, author] = await t.users(2);
      const shops = [
        await t.seedShop(),
        await t.seedShop(),
        await t.seedShop(),
      ];
      for (const shop of shops)
        await t.follow(reader, shop.accountId).expect(204);
      await t.follow(reader, `user:${author.id}`).expect(204);
      await t.feed(reader).expect(200);
      const created: string[] = [];
      for (let i = 0; i < 20; i++)
        created.push(
          (await newProduct(shops[i % 3], minutesAgo(100 - i))).itemId,
        );
      for (let i = 0; i < 10; i++)
        created.push(
          (await t.newPostItem({ authorId: author.id, at: minutesAgo(50 - i) }))
            .itemId,
        );
      await publishAll();

      const spies = [
        instrument(
          t.app.get<FeedItemStore>(FEED_ITEM_STORE, { strict: false }),
          'getMany',
        ),
        instrument(
          t.app.get<ProductCopyStore>(PRODUCT_COPY_STORE, { strict: false }),
          'getMany',
          400,
        ),
        instrument(
          t.app.get(ShopQueryService, { strict: false }),
          'getShopsByIds',
          400,
        ),
        instrument(
          t.app.get(DiscussionQueryService, { strict: false }),
          'getPostsByIds',
          400,
        ),
      ];
      let page: FeedPage;
      let elapsed: number;
      try {
        const started = Date.now();
        page = await read(reader, { limit: 50 });
        elapsed = Date.now() - started;
      } finally {
        spies.forEach((s) => s.restore());
      }

      expect(ids(page)).toEqual(newest(created));
      const [items, copies, shopCalls, postCalls] = spies.map((s) => s.calls);
      expect(items).toHaveLength(1);
      expect(copies).toHaveLength(1);
      expect(shopCalls).toHaveLength(1);
      expect(new Set(shopCalls[0][0] as string[]).size).toBe(3);
      expect(postCalls).toHaveLength(1);
      expect((postCalls[0][0] as string[]).length).toBe(10);
      // sequentially the three 400 ms sources would take 1200 ms
      expect(elapsed!).toBeLessThan(1_100);
    });
  });

  describe('AS-41: a source that decides visibility fails', () => {
    const warnings: string[] = [];
    let spy: jest.SpyInstance;
    beforeEach(() => {
      warnings.length = 0;
      spy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((message: unknown) => {
          warnings.push(
            typeof message === 'string' ? message : JSON.stringify(message),
          );
        });
    });
    afterEach(() => spy.mockRestore());

    it('S26 AS-41: S25 lookup down omits post items, marks the page degraded, serves the rest and leaks nothing', async () => {
      const [reader, author] = await t.users(2);
      const shop = await t.seedShop();
      await t.follow(reader, shop.accountId).expect(204);
      await t.follow(reader, `user:${author.id}`).expect(204);
      await t.feed(reader).expect(200);
      const product = await newProduct(shop, minutesAgo(10));
      await t.newPostItem({ authorId: author.id, at: minutesAgo(5) });
      await publishAll();

      t.faults.postsDown = true;
      const res = await t.feed(reader, { limit: 50 }).expect(200);
      const page = feedPageSchema.parse(res.body);
      expect(page.degraded).toBe(true);
      expect(ids(page)).toEqual([product.itemId]);
      expect(JSON.stringify(res.body)).not.toMatch(/injected|stack|Error/i);
      expect(warnings.join('\n')).toMatch(/posts/);
      expect(warnings.join('\n')).not.toMatch(/\n\s+at /);
    });

    it('S26 AS-41: S03 lookup down omits shop-authored items, serves user-authored ones, and marks the page degraded', async () => {
      const [reader, author] = await t.users(2);
      const shop = await t.seedShop();
      await t.follow(reader, shop.accountId).expect(204);
      await t.follow(reader, `user:${author.id}`).expect(204);
      await t.feed(reader).expect(200);
      await newProduct(shop, minutesAgo(10));
      const post = await t.newPostItem({
        authorId: author.id,
        at: minutesAgo(5),
      });
      await publishAll();

      t.faults.shopsDown = true;
      const res = await t.feed(reader, { limit: 50 }).expect(200);
      const page = feedPageSchema.parse(res.body);
      expect(page.degraded).toBe(true);
      expect(ids(page)).toEqual([post.itemId]);
      expect(JSON.stringify(res.body)).not.toMatch(/injected|stack|Error/i);
      expect(warnings.join('\n')).toMatch(/shops/);

      t.faults.shopsDown = false;
      expect((await read(reader, { limit: 50 })).degraded).toBeUndefined();
    });
  });

  describe('AS-42: stores that are down', () => {
    it('S26 AS-42: with the timeline store down the feed is built by pull, degraded, with an alert line and a counter', async () => {
      const [reader] = await t.users(1);
      const a = await t.seedShop();
      const b = await t.seedShop();
      await activate(reader, a.accountId);
      await activate(reader, b.accountId);
      const created = [
        (await newProduct(a, minutesAgo(30))).itemId,
        (await newProduct(b, minutesAgo(20))).itemId,
        (await newProduct(a, minutesAgo(10))).itemId,
      ];
      await publishAll();
      const lines: unknown[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((message: unknown) => {
          lines.push(message);
        });
      const before =
        MetricsRegistry.value('feed_degraded_total', {
          reason: 'timeline_down',
        }) ?? 0;

      t.faults.timelineDown = true;
      let page: FeedPage;
      try {
        page = await read(reader, { limit: 50 });
      } finally {
        spy.mockRestore();
      }

      expect(page.degraded).toBe(true);
      expect(ids(page)).toEqual(newest(created));
      expect(lines).toContainEqual(
        expect.objectContaining({
          event: 'feed.degraded',
          reason: 'timeline_down',
        }),
      );
      expect(
        MetricsRegistry.value('feed_degraded_total', {
          reason: 'timeline_down',
        }),
      ).toBeGreaterThan(before);
    });

    it('S26 AS-42: with the durable store down the answer is 503 feed_unavailable with Retry-After and no internals', async () => {
      const [reader] = await t.users(1);
      const shop = await t.seedShop();
      await activate(reader, shop.accountId);

      t.faults.durableDown = true;
      const res = await t.feed(reader).expect(503);

      expect(res.headers['content-type']).toContain('problem+json');
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.code).toBe('feed_unavailable');
      expect(JSON.stringify(res.body)).not.toMatch(
        /scylla|cassandra|redis|select |insert |injected|timed ?out|stack|\bat .*\(/i,
      );

      t.faults.durableDown = false;
      await t.feed(reader).expect(200);
    });
  });
});
