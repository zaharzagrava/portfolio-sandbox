import { z } from 'zod';

/**
 * S21 limited-drop auctions (specs/domains/S21-limited-drops/contracts/http.md). Money is integer minor units of the
 * auction's currency, named `…Minor`. A maximum, a user ID or the reserve amount never appears in a public shape.
 */

const instant = z.iso.datetime({ offset: true });
export const AUCTION_MAX_MINOR = 1_000_000_000_000;
const money = z.number().int().min(1).max(AUCTION_MAX_MINOR);
const currency = z.string().regex(/^[A-Z]{3}$/);

export const AUCTION_PAGE_DEFAULT_LIMIT = 20;
export const AUCTION_PAGE_MAX_LIMIT = 100;
export const AUCTION_BATCH_MAX_PRODUCTS = 100;

export const AUCTION_STATUSES = [
  'SCHEDULED',
  'OPEN',
  'CLOSED',
  'SECOND_CHANCE',
  'SOLD',
  'UNSOLD',
  'CANCELLED',
] as const;
export const auctionStatusSchema = z.enum(AUCTION_STATUSES);
export type AuctionStatusValue = z.infer<typeof auctionStatusSchema>;

export const AUCTION_STATUS_REASONS = [
  'no_bids',
  'reserve_not_met',
  'leader_ineligible',
  'winner_unpaid',
  'second_chance_unpaid',
  'seller_cancelled',
  'stock_hold_failed',
] as const;
export const auctionStatusReasonSchema = z.enum(AUCTION_STATUS_REASONS);

export const bidOutcomeSchema = z.enum(['leading', 'outbid', 'raised']);

/** `POST /shops/:shopId/auctions`. Strict: `shopId` comes from the path, unknown properties are refused. */
export const auctionCreateRequestSchema = z
  .object({
    productId: z.string().uuid(),
    title: z.string().min(1).max(140),
    startingPriceMinor: money,
    minIncrementMinor: money,
    reservePriceMinor: money.optional(),
    startsAt: instant,
    endsAt: instant,
  })
  .strict();
export type AuctionCreateRequest = z.infer<typeof auctionCreateRequestSchema>;

/** Seller view: includes the reserve amount, never a bidder's ID or maximum. */
export const auctionMemberSchema = z
  .object({
    id: z.string().uuid(),
    shopId: z.string().uuid(),
    productId: z.string().uuid(),
    title: z.string(),
    currency,
    startingPriceMinor: z.number().int(),
    minIncrementMinor: z.number().int(),
    reservePriceMinor: z.number().int().nullable(),
    startsAt: instant,
    endsAt: instant,
    originalEndsAt: instant,
    status: auctionStatusSchema,
    statusReason: auctionStatusReasonSchema.nullable(),
    priceMinor: z.number().int(),
    bidCount: z.number().int().nonnegative(),
    leaderAlias: z.string().nullable(),
    reserveMet: z.boolean(),
    winnerOrderId: z.string().uuid().nullable(),
    finalPriceMinor: z.number().int().nullable(),
    version: z.number().int().nonnegative(),
    createdAt: instant,
  })
  .strict();
export type AuctionMember = z.infer<typeof auctionMemberSchema>;

export const auctionListQuerySchema = z
  .object({
    status: auctionStatusSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AUCTION_PAGE_MAX_LIMIT)
      .default(AUCTION_PAGE_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type AuctionListQuery = z.infer<typeof auctionListQuerySchema>;

export const auctionPageSchema = z
  .object({
    items: z.array(auctionMemberSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type AuctionPage = z.infer<typeof auctionPageSchema>;

/** `GET /auctions/:auctionId` and the items of `GET /auctions?productIds=` (the BFF's R2 target, S48). */
export const auctionPublicSchema = z
  .object({
    auctionId: z.string().uuid(),
    productId: z.string().uuid(),
    shopId: z.string().uuid(),
    title: z.string(),
    currency,
    status: auctionStatusSchema,
    startsAt: instant,
    endsAt: instant,
    priceMinor: z.number().int(),
    minimumNextMaxMinor: z.number().int(),
    bidCount: z.number().int().nonnegative(),
    hasReserve: z.boolean(),
    reserveMet: z.boolean(),
    leaderAlias: z.string().nullable(),
    version: z.number().int().nonnegative(),
    serverTime: instant,
  })
  .strict();
export type AuctionPublic = z.infer<typeof auctionPublicSchema>;

export const auctionsResponseSchema = z.array(auctionPublicSchema);

/** `?productIds=a,b,c`: at most 100 distinct UUIDs. */
export const auctionBatchQuerySchema = z
  .object({
    productIds: z
      .string()
      .min(1)
      .transform((value) => value.split(',').map((part) => part.trim()))
      .pipe(
        z
          .array(z.string().uuid())
          .min(1)
          .max(AUCTION_BATCH_MAX_PRODUCTS)
          .transform((ids) => [...new Set(ids)]),
      ),
  })
  .strict();

export const bidRequestSchema = z
  .object({ maxAmountMinor: money })
  .strict();
export type BidRequest = z.infer<typeof bidRequestSchema>;

export const bidResultSchema = z
  .object({
    outcome: bidOutcomeSchema,
    priceMinor: z.number().int(),
    youAreLeading: z.boolean(),
    leaderAlias: z.string().nullable(),
    endsAt: instant,
    version: z.number().int().nonnegative(),
    serverTime: instant,
    minimumNextMaxMinor: z.number().int(),
    reserveMet: z.boolean(),
    hasReserve: z.boolean(),
  })
  .strict();
export type BidResult = z.infer<typeof bidResultSchema>;

export const bidHistoryQuerySchema = auctionListQuerySchema
  .omit({ status: true })
  .strict();
export type BidHistoryQuery = z.infer<typeof bidHistoryQuerySchema>;

export const bidHistoryItemSchema = z
  .object({
    sequence: z.number().int().min(1),
    priceMinor: z.number().int(),
    outcome: z.enum(['leading', 'outbid']),
    bidderAlias: z.string(),
    placedAt: instant,
  })
  .strict();

export const bidHistoryPageSchema = z
  .object({
    items: z.array(bidHistoryItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type BidHistoryPage = z.infer<typeof bidHistoryPageSchema>;

/** `GET /auctions/:auctionId/my-bid`: the caller's own maximum only. */
export const myBidSchema = z
  .object({
    maxAmountMinor: z.number().int().nullable(),
    isLeading: z.boolean(),
    priceMinor: z.number().int(),
  })
  .strict();
export type MyBid = z.infer<typeof myBidSchema>;

/** Realtime messages on topic `auction:<auctionId>` (S51). No winner identity, no maximum. */
export const auctionPriceMessageSchema = z
  .object({
    auctionId: z.string().uuid(),
    priceMinor: z.number().int(),
    leaderAlias: z.string().nullable(),
    endsAt: instant,
    reserveMet: z.boolean(),
    version: z.number().int().nonnegative(),
    serverTime: instant,
  })
  .strict();
export const auctionClosedMessageSchema = z
  .object({
    auctionId: z.string().uuid(),
    status: z.enum(['CLOSED', 'UNSOLD']),
    finalPriceMinor: z.number().int().nullable(),
    version: z.number().int().nonnegative(),
  })
  .strict();

/** Stable problem `code`s of the routes (the problem+json `code` member). */
export const AUCTION_PROBLEM_CODES = [
  'validation_failed',
  'invalid_cursor',
  'auction_not_found',
  'product_not_found',
  'auction_exists_for_product',
  'auction_has_bids',
  'auction_not_cancellable',
  'auction_not_started',
  'auction_closed',
  'bid_too_low',
  'bid_not_increasing',
  'shill_bid_forbidden',
  'bid_unavailable',
  'reserve_below_starting',
  'starts_too_soon',
  'duration_out_of_range',
  'product_unavailable',
  'insufficient_stock',
  'rate_limited',
] as const;
export const auctionProblemCodeSchema = z.enum(AUCTION_PROBLEM_CODES);
