import type { FeedItemKind } from '@marketplace-sandbox/contracts';
import type { ProductCopy } from './version-guard';

/**
 * Event to feed item mapping (S26 B3, B5, FR-020/021). Pure: the caller passes the previous product copy and the
 * tombstone state it read, and acts on the decision (claim and store the draft, drop the event, or retry it later).
 * Money is integer minor units; anything else creates nothing.
 */
export const PRICE_DROP_CLAIM_TTL_SECONDS = 86_400;

export interface ItemDraft {
  kind: FeedItemKind;
  /** `shop:<id>` or `user:<id>`. */
  authorId: string;
  title: string;
  /** Hydration keys (null when not applicable). */
  productId: string | null;
  shopId: string | null;
  postId: string | null;
  payload: Record<string, string | number>;
  /** With `kind`, the claim key: one item per (kind, source). */
  sourceKey: string;
  /** Claim TTL; null = the claim lives as long as the source. */
  claimTtlSeconds: number | null;
}

export type ItemDecision =
  | { action: 'create'; draft: ItemDraft }
  | { action: 'skip'; reason: string }
  | { action: 'retry'; reason: string };

const skip = (reason: string): ItemDecision => ({ action: 'skip', reason });

export interface ProductEventInput {
  productId: string;
  shopId: string;
  title: string;
  priceMinor: number;
  currency: string;
  status: ProductCopy['status'];
  isSandbox: boolean;
  productVersion: number;
  changedFields: readonly string[];
  /** Absent means `seller` (events written before the field existed). */
  source?: 'seller' | 'import' | 'integration';
}

export type ProductEventKind =
  'created' | 'updated' | 'archived' | 'restored' | 'deleted';

/** `previous` is the copy stored before this event (null when none). */
export function productItem(
  kind: ProductEventKind,
  event: ProductEventInput,
  previous: ProductCopy | null,
): ItemDecision {
  if (kind !== 'created' && kind !== 'updated') return skip('visibility_only');
  if (!Number.isSafeInteger(event.priceMinor)) return skip('invalid_money');
  if (event.status !== 'ACTIVE') return skip('not_active');
  if (event.isSandbox) return skip('sandbox');
  const base = {
    authorId: `shop:${event.shopId}`,
    title: event.title,
    productId: event.productId,
    shopId: event.shopId,
    postId: null,
    sourceKey: event.productId,
  };
  if (kind === 'created') {
    if (event.source && event.source !== 'seller') return skip('bulk_origin');
    if (previous) {
      if (previous.status === 'DELETED') return skip('deleted');
      if (previous.productVersion > event.productVersion) return skip('stale');
    }
    return {
      action: 'create',
      draft: {
        ...base,
        kind: 'new_product',
        payload: {
          productId: event.productId,
          priceMinor: event.priceMinor,
          currency: event.currency,
        },
        claimTtlSeconds: null,
      },
    };
  }
  if (!event.changedFields.includes('priceMinor'))
    return skip('no_price_change');
  if (!previous || previous.status === 'DELETED') return skip('no_previous');
  if (previous.productVersion >= event.productVersion) return skip('stale');
  if (previous.currency !== event.currency) return skip('currency_changed');
  if (event.priceMinor >= previous.priceMinor) return skip('not_a_drop');
  return {
    action: 'create',
    draft: {
      ...base,
      kind: 'price_drop',
      payload: {
        productId: event.productId,
        previousPriceMinor: previous.priceMinor,
        priceMinor: event.priceMinor,
        currency: event.currency,
      },
      claimTtlSeconds: PRICE_DROP_CLAIM_TTL_SECONDS,
    },
  };
}

export interface PostCreatedInput {
  postId: string;
  boardId: string;
  authorId: string;
  title: string;
  createdAt: string;
}

export function postItem(
  event: PostCreatedInput,
  tombstoned: boolean,
): ItemDecision {
  if (tombstoned) return skip('post_deleted');
  return {
    action: 'create',
    draft: {
      kind: 'post',
      authorId: `user:${event.authorId}`,
      title: event.title,
      productId: null,
      shopId: null,
      postId: event.postId,
      payload: { postId: event.postId, boardId: event.boardId },
      sourceKey: event.postId,
      claimTtlSeconds: null,
    },
  };
}

export type AuctionEventInput =
  | { auctionId: string; shopId: string; productId: string; startsAt: string }
  | { auctionId: string; shopId: string; productId: string; endsAt: string };

/** The title comes from the product copy; without it the event is retried (FR-025). */
export function auctionItem(
  kind: 'created' | 'opened',
  event: AuctionEventInput,
  product: ProductCopy | null,
): ItemDecision {
  if (!product) return { action: 'retry', reason: 'product_copy_missing' };
  if (product.status === 'DELETED') return skip('product_deleted');
  const base = {
    authorId: `shop:${event.shopId}`,
    title: product.title,
    productId: event.productId,
    shopId: event.shopId,
    postId: null,
    sourceKey: event.auctionId,
    claimTtlSeconds: null,
  };
  if (kind === 'created') {
    const startsAt = 'startsAt' in event ? event.startsAt : '';
    return {
      action: 'create',
      draft: {
        ...base,
        kind: 'drop_announced',
        payload: {
          auctionId: event.auctionId,
          productId: event.productId,
          startsAt,
        },
      },
    };
  }
  const endsAt = 'endsAt' in event ? event.endsAt : '';
  return {
    action: 'create',
    draft: {
      ...base,
      kind: 'auction_started',
      payload: {
        auctionId: event.auctionId,
        productId: event.productId,
        endsAt,
      },
    },
  };
}
