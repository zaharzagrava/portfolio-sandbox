import { z } from 'zod';

/**
 * S26 follow graph and home feed wire shapes (specs/domains/S26-follow-feed/contracts/follow-feed-api.md).
 * Money is integer minor units. Account ids are `shop:<uuid>` or `user:<uuid>` (lowercase UUID). Responses stay open to
 * additive fields.
 */
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const FEED_ACCOUNT_ID_PATTERN = new RegExp(`^(shop|user):${uuid}$`);
export const feedAccountIdSchema = z.string().regex(FEED_ACCOUNT_ID_PATTERN);

export const FEED_ITEM_KINDS = [
  'new_product',
  'price_drop',
  'post',
  'drop_announced',
  'auction_started',
] as const;
export const feedItemKindSchema = z.enum(FEED_ITEM_KINDS);
export type FeedItemKind = z.infer<typeof feedItemKindSchema>;

const minor = z.number().int();
const currency = z.string();

export const feedPayloadSchemas = {
  new_product: z.object({
    productId: z.string(),
    priceMinor: minor,
    currency,
  }),
  price_drop: z.object({
    productId: z.string(),
    previousPriceMinor: minor,
    priceMinor: minor,
    currency,
  }),
  post: z.object({ postId: z.string(), boardId: z.string() }),
  drop_announced: z.object({
    auctionId: z.string(),
    productId: z.string(),
    startsAt: z.string(),
  }),
  auction_started: z.object({
    auctionId: z.string(),
    productId: z.string(),
    endsAt: z.string(),
  }),
} as const;

const feedAuthor = z.object({
  accountId: feedAccountIdSchema,
  type: z.enum(['shop', 'user']),
  name: z.string().nullable(),
});

const itemBase = {
  itemId: z.string(),
  author: feedAuthor,
  title: z.string(),
  createdAt: z.string(),
};

export const feedItemViewSchema = z.discriminatedUnion('kind', [
  z.object({
    ...itemBase,
    kind: z.literal('new_product'),
    payload: feedPayloadSchemas.new_product,
  }),
  z.object({
    ...itemBase,
    kind: z.literal('price_drop'),
    payload: feedPayloadSchemas.price_drop,
  }),
  z.object({
    ...itemBase,
    kind: z.literal('post'),
    payload: feedPayloadSchemas.post,
  }),
  z.object({
    ...itemBase,
    kind: z.literal('drop_announced'),
    payload: feedPayloadSchemas.drop_announced,
  }),
  z.object({
    ...itemBase,
    kind: z.literal('auction_started'),
    payload: feedPayloadSchemas.auction_started,
  }),
]);
export type FeedItemView = z.infer<typeof feedItemViewSchema>;

export const feedPageSchema = z.object({
  items: z.array(feedItemViewSchema),
  nextCursor: z.string().nullable(),
  degraded: z.literal(true).optional(),
});
export type FeedPage = z.infer<typeof feedPageSchema>;

export const followingPageSchema = z.object({
  items: z.array(
    z.object({ accountId: feedAccountIdSchema, followedAt: z.string() }),
  ),
  nextCursor: z.string().nullable(),
});
export type FollowingPage = z.infer<typeof followingPageSchema>;

export const followStatusSchema = z.array(
  z.object({
    accountId: z.string(),
    following: z.boolean(),
    followerCount: z.number().int().nonnegative(),
  }),
);
export type FollowStatus = z.infer<typeof followStatusSchema>;

/** Problem `code`s of the follow and feed routes (the rate-limit family is shared with S50). */
export const FEED_ERROR_CODES = [
  'validation_failed',
  'account_not_found',
  'cannot_follow_self',
  'following_limit_reached',
  'invalid_cursor',
  'rate_limited',
  'rate_limiter_unavailable',
  'rate_limit_cost_exceeded',
  'feed_unavailable',
] as const;
export const feedErrorCodeSchema = z.enum(FEED_ERROR_CODES);
export type FeedErrorCode = z.infer<typeof feedErrorCodeSchema>;
