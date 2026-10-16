import {
  auctionItem,
  PRICE_DROP_CLAIM_TTL_SECONDS,
  postItem,
  productItem,
  type ProductEventInput,
} from './item-rules';
import type { ProductCopy } from './version-guard';

const snapshot = (
  over: Partial<ProductEventInput> = {},
): ProductEventInput => ({
  productId: 'p1',
  shopId: 's1',
  title: 'Lamp',
  priceMinor: 12_900,
  currency: 'USD',
  status: 'ACTIVE',
  isSandbox: false,
  productVersion: 1,
  changedFields: [],
  ...over,
});

const copy = (over: Partial<ProductCopy> = {}): ProductCopy => ({
  productId: 'p1',
  shopId: 's1',
  title: 'Lamp',
  priceMinor: 12_900,
  currency: 'USD',
  status: 'ACTIVE',
  isSandbox: false,
  productVersion: 1,
  ...over,
});

describe('feed item rules', () => {
  describe('products', () => {
    it('S26 AS-14: product_created ACTIVE non-sandbox is a new_product item of the shop', () => {
      const d = productItem('created', snapshot(), null);
      expect(d).toMatchObject({
        action: 'create',
        draft: {
          kind: 'new_product',
          authorId: 'shop:s1',
          title: 'Lamp',
          productId: 'p1',
          shopId: 's1',
          postId: null,
          payload: { productId: 'p1', priceMinor: 12_900, currency: 'USD' },
          sourceKey: 'p1',
          claimTtlSeconds: null,
        },
      });
    });

    it.each([
      ['sandbox', { isSandbox: true }],
      ['archived at creation', { status: 'ARCHIVED' as const }],
    ])('S26 AS-14: product_created %s creates nothing', (_n, over) => {
      expect(productItem('created', snapshot(over), null).action).toBe('skip');
    });

    it('S26 AS-17: a created event older than the stored copy (archived v5) creates nothing', () => {
      const stored = copy({ productVersion: 5, status: 'ARCHIVED' });
      expect(
        productItem('created', snapshot({ productVersion: 4 }), stored).action,
      ).toBe('skip');
      expect(
        productItem(
          'created',
          snapshot({ productVersion: 4 }),
          copy({ status: 'DELETED', productVersion: 9 }),
        ).action,
      ).toBe('skip');
    });

    it('S26 AS-14: a lower price with priceMinor changed is a price_drop with previous and new price', () => {
      const d = productItem(
        'updated',
        snapshot({
          priceMinor: 9_900,
          productVersion: 2,
          changedFields: ['priceMinor'],
        }),
        copy(),
      );
      expect(d).toMatchObject({
        action: 'create',
        draft: {
          kind: 'price_drop',
          payload: {
            productId: 'p1',
            previousPriceMinor: 12_900,
            priceMinor: 9_900,
            currency: 'USD',
          },
          sourceKey: 'p1',
          claimTtlSeconds: PRICE_DROP_CLAIM_TTL_SECONDS,
        },
      });
      expect(PRICE_DROP_CLAIM_TTL_SECONDS).toBe(86_400);
    });

    it.each([
      [
        'a price increase',
        { priceMinor: 20_000, changedFields: ['priceMinor' as const] },
      ],
      [
        'an equal price',
        { priceMinor: 12_900, changedFields: ['priceMinor' as const] },
      ],
      [
        'an update that changes no price',
        { priceMinor: 9_900, changedFields: ['title' as const] },
      ],
      [
        'a sandbox product',
        {
          isSandbox: true,
          priceMinor: 9_900,
          changedFields: ['priceMinor' as const],
        },
      ],
      [
        'a product that is not ACTIVE',
        {
          status: 'ARCHIVED' as const,
          priceMinor: 9_900,
          changedFields: ['priceMinor' as const],
        },
      ],
      [
        'a price in another currency',
        {
          currency: 'EUR',
          priceMinor: 9_900,
          changedFields: ['priceMinor' as const],
        },
      ],
    ])('S26 AS-14: %s creates nothing', (_n, over) => {
      expect(
        productItem('updated', snapshot({ productVersion: 2, ...over }), copy())
          .action,
      ).toBe('skip');
    });

    it('S26 AS-14: a drop with no known previous price (no copy) or a stale event creates nothing', () => {
      const drop = snapshot({
        priceMinor: 9_900,
        productVersion: 2,
        changedFields: ['priceMinor'],
      });
      expect(productItem('updated', drop, null).action).toBe('skip');
      expect(
        productItem('updated', drop, copy({ productVersion: 2 })).action,
      ).toBe('skip');
    });

    it('S26 AS-14: any decrease counts, including one minor unit', () => {
      const d = productItem(
        'updated',
        snapshot({
          priceMinor: 12_899,
          productVersion: 2,
          changedFields: ['priceMinor', 'title'],
        }),
        copy(),
      );
      expect(d.action).toBe('create');
    });

    it.each(['archived', 'restored', 'deleted'] as const)(
      'S26 AS-14: product_%s creates nothing (visibility only)',
      (kind) => {
        expect(
          productItem(kind, snapshot({ productVersion: 2 }), copy()).action,
        ).toBe('skip');
      },
    );

    it('S26 AS-43: money must be integer minor units, a fractional price creates nothing', () => {
      expect(
        productItem('created', snapshot({ priceMinor: 12.5 }), null).action,
      ).toBe('skip');
    });
  });

  describe('posts', () => {
    const post = {
      postId: 'post-1',
      boardId: 'board-1',
      authorId: 'u1',
      title: 'Hello',
      createdAt: '2026-10-16T10:00:00.000Z',
    };

    it('S26 AS-14: discussion.post_created is a post item authored by user:<authorId>', () => {
      expect(postItem(post, false)).toMatchObject({
        action: 'create',
        draft: {
          kind: 'post',
          authorId: 'user:u1',
          title: 'Hello',
          postId: 'post-1',
          productId: null,
          shopId: null,
          payload: { postId: 'post-1', boardId: 'board-1' },
          sourceKey: 'post-1',
        },
      });
    });

    it('S26 AS-17: a post deleted before its creation event creates nothing', () => {
      expect(postItem(post, true)).toMatchObject({ action: 'skip' });
    });
  });

  describe('auctions', () => {
    const created = {
      auctionId: 'a1',
      shopId: 's1',
      productId: 'p1',
      startsAt: '2026-10-20T10:00:00.000Z',
      endsAt: '2026-10-21T10:00:00.000Z',
    };

    it('S26 AS-14: auction.created is a drop_announced item of the shop titled by the product', () => {
      expect(auctionItem('created', created, copy())).toMatchObject({
        action: 'create',
        draft: {
          kind: 'drop_announced',
          authorId: 'shop:s1',
          title: 'Lamp',
          productId: 'p1',
          shopId: 's1',
          payload: {
            auctionId: 'a1',
            productId: 'p1',
            startsAt: created.startsAt,
          },
          sourceKey: 'a1',
        },
      });
    });

    it('S26 AS-14: auction.opened is an auction_started item with endsAt', () => {
      expect(
        auctionItem(
          'opened',
          {
            auctionId: 'a1',
            shopId: 's1',
            productId: 'p1',
            endsAt: created.endsAt,
          },
          copy(),
        ),
      ).toMatchObject({
        action: 'create',
        draft: {
          kind: 'auction_started',
          payload: { auctionId: 'a1', productId: 'p1', endsAt: created.endsAt },
          sourceKey: 'a1',
        },
      });
    });

    it('S26 AS-17: without a product copy the event must be retried, not dropped', () => {
      expect(
        auctionItem(
          'opened',
          {
            auctionId: 'a1',
            shopId: 's1',
            productId: 'p1',
            endsAt: created.endsAt,
          },
          null,
        ),
      ).toMatchObject({
        action: 'retry',
      });
    });

    it('S26 AS-17: a deleted product creates nothing', () => {
      expect(
        auctionItem(
          'created',
          created,
          copy({ status: 'DELETED', productVersion: 9 }),
        ).action,
      ).toBe('skip');
    });
  });
});
