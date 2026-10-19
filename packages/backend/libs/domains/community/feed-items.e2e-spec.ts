import { types } from 'cassandra-driver';
import { v4 as uuidv4 } from 'uuid';
import { feedPageSchema } from '@marketplace-sandbox/contracts';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { announcementShard } from './domain/feed-events';
import { monthBucketOf } from './domain/months';
import {
  FeedAuctionsProjector,
  FeedFanoutProjector,
  FeedPostsProjector,
  FeedProductsProjector,
} from './infra/feed-projectors';
import {
  createFeedApp,
  sortable,
  type FeedTestApp,
  type TestUser,
} from './testing/feed-fixtures';

/**
 * S26 US2: items from events (AS-13..AS-17). Source events are delivered through the real consumers (the projector
 * classes, handed batches exactly as the S53 runner does); announcements go through the real relay; fan-out through the
 * real fan-out consumer. Every test creates its own users, shops and products.
 */
describe('Follow feed: items from events, idempotency and out-of-order delivery', () => {
  let t: FeedTestApp;
  const products = () => t.projector(FeedProductsProjector);
  const posts = () => t.projector(FeedPostsProjector);
  const auctions = () => t.projector(FeedAuctionsProjector);
  const fanout = () => t.projector(FeedFanoutProjector);

  beforeAll(async () => {
    t = await createFeedApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  // ---- persisted state ------------------------------------------------------------------------------------------
  const claim = async (kind: string, sourceKey: string) =>
    (
      await t.cql(
        'SELECT item_id, TTL(item_id) AS ttl FROM item_claims WHERE kind = ? AND source_key = ?',
        [kind, sourceKey],
      )
    ).first();
  const itemRow = async (itemId: string) =>
    (
      await t.cql(
        'SELECT item_id, author_id, kind, title, payload, created_at, product_id, shop_id, post_id, TTL(title) AS ttl FROM feed_items WHERE item_id = ?',
        [itemId],
      )
    ).first();
  const history = async (authorId: string) =>
    (
      await t.cql(
        'SELECT item_id, kind, TTL(kind) AS ttl FROM items_by_author WHERE author_id = ? AND month = ?',
        [authorId, monthBucketOf(t.clock.now())],
      )
    ).rows;
  const pendingRows = async (itemId: string) =>
    (
      await t.cql(
        'SELECT item_id, author_id, kind FROM pending_announcements WHERE hour_shard = ? AND item_id = ?',
        [
          types.Long.fromNumber(announcementShard(itemId, t.clock.now())),
          itemId,
        ],
      )
    ).rows;
  const copy = async (productId: string) =>
    (
      await t.cql(
        'SELECT status, product_version, price_minor FROM product_copies WHERE product_id = ?',
        [productId],
      )
    ).first();
  const tombstone = async (postId: string) =>
    (
      await t.cql('SELECT post_id FROM post_tombstones WHERE post_id = ?', [
        postId,
      ])
    ).first();

  /** The id of the item created for (kind, source), or null. */
  const itemIdOf = async (kind: string, sourceKey: string) =>
    (await claim(kind, sourceKey))?.item_id?.toString() ?? null;

  const activate = async (user: TestUser, accountId: string) => {
    await t.follow(user, accountId).expect(204);
    await t.feed(user).expect(200); // reading the feed marks the user active
  };
  const page = async (user: TestUser) =>
    feedPageSchema.parse((await t.feed(user).expect(200)).body);

  describe('AS-13: a product event reaches an active follower', () => {
    it('S26 AS-13: the item is stored once with its shape, announced once and pushed to the active follower', async () => {
      const [reader] = await t.users(1);
      const shop = await t.seedShop({ name: 'Lamp Works' });
      await activate(reader, shop.accountId);
      const productId = uuidv4();

      await products().project([
        t.productEvent('created', {
          productId,
          shopId: shop.shopId,
          title: 'Brass lamp',
          priceMinor: 12_900,
          currency: 'USD',
        }),
      ]);

      const itemId = (await itemIdOf('new_product', productId))!;
      expect(itemId).toBeTruthy();
      const row = (await itemRow(itemId))!;
      expect(row.author_id).toBe(shop.accountId);
      expect(row.kind).toBe('new_product');
      expect(row.title).toBe('Brass lamp');
      expect(JSON.parse(row.payload)).toEqual({
        productId,
        priceMinor: 12_900,
        currency: 'USD',
      });
      expect(row.product_id).toBe(productId);
      expect(row.shop_id).toBe(shop.shopId);
      expect(row.post_id).toBeNull();
      expect(row.created_at.toISOString()).toBe(t.clock.now().toISOString());
      expect(row.ttl).toBeGreaterThan(0);
      expect(row.ttl).toBeLessThanOrEqual(7_776_000);
      expect(await history(shop.accountId)).toHaveLength(1);
      expect(await pendingRows(itemId)).toHaveLength(1);
      expect((await copy(productId))!.status).toBe('ACTIVE');

      const announced = await t.announce();
      expect(announced).toHaveLength(1);
      expect(announced[0].type).toBe('feed.item_published');
      expect(announced[0].aggregateId).toBe(shop.accountId);
      expect(announced[0].payload).toEqual({
        itemId,
        authorId: shop.accountId,
        kind: 'new_product',
        createdAt: t.clock.now().toISOString(),
      });
      expect(await pendingRows(itemId)).toHaveLength(0);

      await t.fanOut(announced);
      const timeline = await t.redis.zrange(`fd:tl:{${reader.id}}`, 0, -1);
      expect(timeline).toEqual([sortable(itemId)]);
      expect(await t.redis.ttl(`fd:tl:{${reader.id}}`)).toBeGreaterThan(0);

      const feed = await page(reader);
      expect(feed).toEqual({
        items: [
          {
            itemId,
            kind: 'new_product',
            author: {
              accountId: shop.accountId,
              type: 'shop',
              name: 'Lamp Works',
            },
            title: 'Brass lamp',
            payload: { productId, priceMinor: 12_900, currency: 'USD' },
            createdAt: t.clock.now().toISOString(),
          },
        ],
        nextCursor: null,
      });
    });
  });

  describe('AS-14: events map to items', () => {
    it('S26 AS-14: catalog.product_created (ACTIVE, not sandbox) makes a new_product item', async () => {
      const shop = await t.seedShop();
      const productId = uuidv4();
      await products().project([
        t.productEvent('created', { productId, shopId: shop.shopId }),
      ]);
      const itemId = (await itemIdOf('new_product', productId))!;
      expect((await itemRow(itemId))!.kind).toBe('new_product');
    });

    it('S26 AS-60: a product created by an import or an integration makes no new_product item; a seller create still does', async () => {
      const shop = await t.seedShop();
      const imported = uuidv4();
      const synced = uuidv4();
      const own = uuidv4();
      await products().project([
        t.productEvent('created', {
          productId: imported,
          shopId: shop.shopId,
          source: 'import',
        }),
        t.productEvent('created', {
          productId: synced,
          shopId: shop.shopId,
          source: 'integration',
        }),
        t.productEvent('created', {
          productId: own,
          shopId: shop.shopId,
          source: 'seller',
        }),
      ]);
      expect(await itemIdOf('new_product', imported)).toBeFalsy();
      expect(await itemIdOf('new_product', synced)).toBeFalsy();
      expect(await itemIdOf('new_product', own)).toBeTruthy();
    });

    it('S26 AS-14: a lower price makes a price_drop with the previous price; no other update does', async () => {
      const shop = await t.seedShop();
      const productId = uuidv4();
      await products().project([
        t.productEvent('created', {
          productId,
          shopId: shop.shopId,
          priceMinor: 12_900,
        }),
        t.productEvent('updated', {
          productId,
          shopId: shop.shopId,
          priceMinor: 9_900,
          productVersion: 2,
          changedFields: ['priceMinor'],
        }),
      ]);
      const dropId = (await itemIdOf('price_drop', productId))!;
      const row = (await itemRow(dropId))!;
      expect(row.kind).toBe('price_drop');
      expect(JSON.parse(row.payload)).toEqual({
        productId,
        previousPriceMinor: 12_900,
        priceMinor: 9_900,
        currency: 'USD',
      });
      expect((await claim('price_drop', productId))!.ttl).toBeGreaterThan(0);
      expect((await claim('price_drop', productId))!.ttl).toBeLessThanOrEqual(
        86_400,
      );
    });

    it('S26 AS-14: a post event makes a post item authored by the user', async () => {
      const [author] = await t.users(1);
      const postId = uuidv4();
      const boardId = uuidv4();
      await posts().project([
        t.postCreated({
          postId,
          boardId,
          authorId: author.id,
          title: 'Restoring a lamp',
        }),
      ]);
      const itemId = (await itemIdOf('post', postId))!;
      const row = (await itemRow(itemId))!;
      expect(row.author_id).toBe(`user:${author.id}`);
      expect(row.kind).toBe('post');
      expect(row.title).toBe('Restoring a lamp');
      expect(JSON.parse(row.payload)).toEqual({ postId, boardId });
      expect(row.post_id).toBe(postId);
    });

    it('S26 AS-14: auction.created makes drop_announced and auction.opened makes auction_started', async () => {
      const shop = await t.seedShop();
      const productId = uuidv4();
      await products().project([
        t.productEvent('created', {
          productId,
          shopId: shop.shopId,
          title: 'Drop lamp',
        }),
      ]);
      const auctionId = uuidv4();
      const startsAt = new Date(t.clock.nowMs() + 3_600_000);
      const endsAt = new Date(t.clock.nowMs() + 90_000_000);

      await auctions().project([
        t.auctionCreated({
          auctionId,
          shopId: shop.shopId,
          productId,
          startsAt,
          endsAt,
        }),
      ]);
      const announced = (await itemRow(
        (await itemIdOf('drop_announced', auctionId))!,
      ))!;
      expect(announced.author_id).toBe(shop.accountId);
      expect(announced.title).toBe('Drop lamp');
      expect(JSON.parse(announced.payload)).toEqual({
        auctionId,
        productId,
        startsAt: startsAt.toISOString(),
      });

      await auctions().project([
        t.auctionOpened({
          auctionId,
          shopId: shop.shopId,
          productId,
          endsAt,
        }),
      ]);
      const started = (await itemRow(
        (await itemIdOf('auction_started', auctionId))!,
      ))!;
      expect(started.kind).toBe('auction_started');
      expect(JSON.parse(started.payload)).toEqual({
        auctionId,
        productId,
        endsAt: endsAt.toISOString(),
      });
    });

    it('S26 AS-14: price increases, equal prices, updates without a price change, sandbox, non-ACTIVE creation and visibility events create nothing', async () => {
      const shop = await t.seedShop();
      const productId = uuidv4();
      await products().project([
        t.productEvent('created', {
          productId,
          shopId: shop.shopId,
          priceMinor: 10_000,
        }),
        t.productEvent('updated', {
          productId,
          shopId: shop.shopId,
          priceMinor: 15_000,
          productVersion: 2,
          changedFields: ['priceMinor'],
        }),
        t.productEvent('updated', {
          productId,
          shopId: shop.shopId,
          priceMinor: 15_000,
          productVersion: 3,
          changedFields: ['priceMinor'],
        }),
        t.productEvent('updated', {
          productId,
          shopId: shop.shopId,
          title: 'Renamed',
          priceMinor: 15_000,
          productVersion: 4,
          changedFields: ['title'],
        }),
        t.productEvent('archived', {
          productId,
          shopId: shop.shopId,
          status: 'ARCHIVED',
          productVersion: 5,
        }),
        t.productEvent('restored', {
          productId,
          shopId: shop.shopId,
          productVersion: 6,
        }),
        t.productDeleted({ productId, shopId: shop.shopId, productVersion: 7 }),
      ]);
      const sandboxId = uuidv4();
      const archivedId = uuidv4();
      await products().project([
        t.productEvent('created', {
          productId: sandboxId,
          shopId: shop.shopId,
          isSandbox: true,
        }),
        t.productEvent('created', {
          productId: archivedId,
          shopId: shop.shopId,
          status: 'ARCHIVED',
        }),
      ]);

      // only the creation of the first product made an item
      const rows = await history(shop.accountId);
      expect(rows.map((r) => r.kind)).toEqual(['new_product']);
      expect(await claim('price_drop', productId)).toBeNull();
      expect(await claim('new_product', sandboxId)).toBeNull();
      expect(await claim('new_product', archivedId)).toBeNull();
      expect((await copy(productId))!.status).toBe('DELETED');
    });

    it('S26 AS-14: a second drop within 24 hours creates nothing; once the claim has expired a drop creates a new item', async () => {
      const shop = await t.seedShop();
      const productId = uuidv4();
      const drop = (version: number, priceMinor: number) =>
        t.productEvent('updated', {
          productId,
          shopId: shop.shopId,
          priceMinor,
          productVersion: version,
          changedFields: ['priceMinor'],
        });
      await products().project([
        t.productEvent('created', {
          productId,
          shopId: shop.shopId,
          priceMinor: 12_900,
        }),
        drop(2, 9_900),
      ]);
      const first = (await itemIdOf('price_drop', productId))!;

      t.clock.advance(3_600_000);
      await products().project([drop(3, 7_900)]);
      expect(await itemIdOf('price_drop', productId)).toBe(first);
      expect(
        (await history(shop.accountId)).filter((r) => r.kind === 'price_drop'),
      ).toHaveLength(1);

      // the claim carries a 24 hour TTL in the store (asserted above); its expiry happens in ScyllaDB's own clock,
      // so the test lets it elapse by deleting the claim, exactly what the TTL does
      await t.cql('DELETE FROM item_claims WHERE kind = ? AND source_key = ?', [
        'price_drop',
        productId,
      ]);
      t.clock.advance(25 * 3_600_000);
      await products().project([drop(4, 5_900)]);
      const second = (await itemIdOf('price_drop', productId))!;
      expect(second).not.toBe(first);
      expect(JSON.parse((await itemRow(second))!.payload)).toMatchObject({
        previousPriceMinor: 7_900,
        priceMinor: 5_900,
      });
    });
  });

  describe('AS-15: duplicate and concurrent delivery', () => {
    it('S26 AS-15: the same event twice, and another event for the same product version, make one item and one announcement', async () => {
      const [reader] = await t.users(1);
      const shop = await t.seedShop();
      await activate(reader, shop.accountId);
      const productId = uuidv4();
      const event = t.productEvent('created', {
        productId,
        shopId: shop.shopId,
      });
      const other = t.productEvent('created', {
        productId,
        shopId: shop.shopId,
      });
      expect(other.eventId).not.toBe(event.eventId);

      await products().project([event]);
      await products().project([event]);
      await products().project([other]);

      expect(await history(shop.accountId)).toHaveLength(1);
      const itemId = (await itemIdOf('new_product', productId))!;
      expect(await pendingRows(itemId)).toHaveLength(1);
      const announced = await t.announce();
      expect(announced).toHaveLength(1);
      await t.fanOut(announced);
      expect((await page(reader)).items.map((i) => i.itemId)).toEqual([itemId]);
    });

    it('S26 AS-15: 20 concurrent deliveries make one item and one announcement', async () => {
      const shop = await t.seedShop();
      const productId = uuidv4();
      const events = Array.from({ length: 20 }, () =>
        t.productEvent('created', { productId, shopId: shop.shopId }),
      );

      await Promise.all(events.map((e) => products().project([e])));

      expect(await history(shop.accountId)).toHaveLength(1);
      const itemId = (await itemIdOf('new_product', productId))!;
      expect(await pendingRows(itemId)).toHaveLength(1);
      expect(await t.announce()).toHaveLength(1);
    });

    it('S26 AS-15: 20 concurrent deliveries of a post and of an auction event make one item each', async () => {
      const [author] = await t.users(1);
      const shop = await t.seedShop();
      const productId = uuidv4();
      await products().project([
        t.productEvent('created', { productId, shopId: shop.shopId }),
      ]);
      const postId = uuidv4();
      const auctionId = uuidv4();

      await Promise.all([
        ...Array.from({ length: 20 }, () =>
          posts().project([t.postCreated({ postId, authorId: author.id })]),
        ),
        ...Array.from({ length: 20 }, () =>
          auctions().project([
            t.auctionCreated({ auctionId, shopId: shop.shopId, productId }),
          ]),
        ),
      ]);

      expect(await history(`user:${author.id}`)).toHaveLength(1);
      expect(
        (await history(shop.accountId)).filter(
          (r) => r.kind === 'drop_announced',
        ),
      ).toHaveLength(1);
    });
  });

  describe('AS-16: invalid payloads are dead-lettered without side effects', () => {
    const noSideEffects = async (sourceKeys: Array<[string, string]>) => {
      for (const [kind, key] of sourceKeys)
        expect(await claim(kind, key)).toBeNull();
      expect(await t.feedKeys()).toEqual([]);
    };

    it('S26 AS-16: the product consumer rejects a missing productId and a float or string price, and goes on with the next valid event', async () => {
      const shop = await t.seedShop();
      const valid = t.productEvent('created', { shopId: shop.shopId });
      const invalid = (payload: Record<string, unknown>): EventEnvelope => ({
        ...t.productEvent('created', { shopId: shop.shopId }),
        payload,
      });
      const base = { ...t.productEvent('created', { shopId: shop.shopId }) };
      const missingId = { ...base.payload } as Record<string, unknown>;
      delete missingId.productId;
      const floatPrice = { ...base.payload, priceMinor: 12.5 };
      const stringPrice = { ...base.payload, priceMinor: '12900' };

      const { deadLettered } = await t.deliver(products(), [
        invalid(missingId),
        invalid(floatPrice),
        invalid(stringPrice),
        valid,
      ]);

      expect(deadLettered).toHaveLength(3);
      expect(deadLettered.every((d) => d.reason === 'invalid_payload')).toBe(
        true,
      );
      expect(
        await claim('new_product', base.payload.productId as string),
      ).toBeNull();
      expect(await copy(base.payload.productId as string)).toBeNull();
      expect(await t.feedKeys()).toEqual([]);
      // the valid event after the invalid ones was processed
      expect(
        await itemIdOf('new_product', valid.payload.productId as string),
      ).toBeTruthy();
    });

    it('S26 AS-16: the post consumer rejects a missing postId and a postId that is not a UUID', async () => {
      const [author] = await t.users(1);
      const base = t.postCreated({ authorId: author.id });
      const missing = { ...base.payload } as Record<string, unknown>;
      delete missing.postId;

      const { deadLettered } = await t.deliver(posts(), [
        { ...base, payload: missing },
      ]);
      expect(deadLettered).toHaveLength(1);

      const notUuid = { ...base, payload: { ...base.payload, postId: 'nope' } };
      await expect(posts().project([notUuid])).rejects.toMatchObject({
        name: 'PermanentError',
      });
      await noSideEffects([['post', 'nope']]);
      expect(await history(`user:${author.id}`)).toHaveLength(0);
    });

    it('S26 AS-16: the auction consumer rejects a missing productId', async () => {
      const shop = await t.seedShop();
      const base = t.auctionCreated({
        shopId: shop.shopId,
        productId: uuidv4(),
      });
      const missing = { ...base.payload } as Record<string, unknown>;
      delete missing.productId;

      const { deadLettered } = await t.deliver(auctions(), [
        { ...base, payload: missing },
      ]);

      expect(deadLettered).toHaveLength(1);
      await noSideEffects([
        ['drop_announced', base.payload.auctionId as string],
      ]);
    });

    it('S26 AS-16: the fan-out consumer rejects an announcement without itemId and pushes nothing', async () => {
      const [reader] = await t.users(1);
      const shop = await t.seedShop();
      await activate(reader, shop.accountId);
      const base = t.itemPublished({
        itemId: '00000000-0000-1000-8000-000000000001',
        authorId: shop.accountId,
      });
      const missing = { ...base.payload } as Record<string, unknown>;
      delete missing.itemId;

      const { deadLettered } = await t.deliver(fanout(), [
        { ...base, payload: missing },
      ]);

      expect(deadLettered).toHaveLength(1);
      expect(await t.redis.exists(`fd:tl:{${reader.id}}`)).toBe(0);
    });
  });

  describe('AS-17: out-of-order source events', () => {
    it('S26 AS-17: an archive at version 5 before the creation at version 4 keeps the archive and the product never reaches a feed', async () => {
      const [reader] = await t.users(1);
      const shop = await t.seedShop();
      await activate(reader, shop.accountId);
      const productId = uuidv4();

      await products().project([
        t.productEvent('archived', {
          productId,
          shopId: shop.shopId,
          status: 'ARCHIVED',
          productVersion: 5,
        }),
      ]);
      await products().project([
        t.productEvent('created', {
          productId,
          shopId: shop.shopId,
          productVersion: 4,
        }),
      ]);

      const row = (await copy(productId))!;
      expect(row.status).toBe('ARCHIVED');
      expect(Number(row.product_version)).toBe(5);
      expect(await claim('new_product', productId)).toBeNull();
      expect(await t.announce()).toEqual([]);
      expect((await page(reader)).items).toEqual([]);
    });

    it('S26 AS-17: a post deleted before it was created is remembered and the late creation makes no item', async () => {
      const [author] = await t.users(1);
      const postId = uuidv4();

      await posts().project([t.postDeleted({ postId })]);
      expect(await tombstone(postId)).toBeTruthy();
      await posts().project([t.postCreated({ postId, authorId: author.id })]);

      expect(await claim('post', postId)).toBeNull();
      expect(await history(`user:${author.id}`)).toHaveLength(0);
    });

    it('S26 AS-17: auction.opened before the product copy exists is retried (at most 5 attempts) and makes the item exactly once once the copy exists', async () => {
      const shop = await t.seedShop();
      const productId = uuidv4();
      const auctionId = uuidv4();
      const opened = t.auctionOpened({
        auctionId,
        shopId: shop.shopId,
        productId,
      });
      expect(auctions().attempts).toBeLessThanOrEqual(5);
      expect(auctions().attempts).toBeGreaterThan(1);

      await expect(auctions().project([opened])).rejects.toMatchObject({
        name: 'PermanentError',
      });
      expect(await claim('auction_started', auctionId)).toBeNull();
      expect(await history(shop.accountId)).toHaveLength(0);

      await products().project([
        t.productEvent('created', { productId, shopId: shop.shopId }),
      ]);
      await auctions().project([opened]);
      await auctions().project([opened]);

      expect(
        (await history(shop.accountId)).filter(
          (r) => r.kind === 'auction_started',
        ),
      ).toHaveLength(1);
    });
  });
});
