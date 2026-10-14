import { z } from 'zod';
import {
  auctionStatusReasonSchema,
  bidOutcomeSchema,
} from './auction.ts';

/**
 * `auctions.events` payloads of S21 (specs/domains/S21-limited-drops/contracts/events.md); the topic key is
 * `auctionId`. Every payload carries `auctionId`, `shopId`, `productId` and `auctionVersion` (the auction version
 * after the change, strictly increasing per auction). Money is `…Minor` with `currency`. No payload ever carries a
 * maximum or the reserve amount. The field names are the ones S28's `consumed-events.ts` already parses.
 */
const id = z.string().min(1);
const minor = z.number().int().nonnegative();
const currency = z.string().regex(/^[A-Z]{3}$/);
const instant = z.string().min(1);

const base = {
  auctionId: id,
  shopId: id,
  productId: id,
  auctionVersion: z.number().int().nonnegative(),
};

export const auctionEventSchemas = {
  'auction.created': z.object({
    ...base,
    startsAt: instant,
    endsAt: instant,
    currency,
  }),
  'auction.opened': z.object({ ...base, endsAt: instant }),
  'auction.bid_placed': z.object({
    ...base,
    bidderId: id,
    outcome: bidOutcomeSchema,
    priceMinor: minor,
    currency,
    leaderId: id,
    endsAt: instant,
    extended: z.boolean(),
    sequence: z.number().int().min(1),
  }),
  'auction.leader_changed': z.object({
    ...base,
    previousLeaderId: id,
    leaderId: id,
    priceMinor: minor,
    currency,
  }),
  'auction.closed': z.object({
    ...base,
    status: z.enum(['CLOSED', 'UNSOLD']),
    winnerId: id.nullable(),
    finalPriceMinor: minor.nullable(),
    currency,
    reserveMet: z.boolean(),
    reason: z.enum(['winner', 'no_bids', 'reserve_not_met', 'leader_ineligible']),
  }),
  'auction.second_chance_offered': z.object({
    ...base,
    offeredToId: id,
    priceMinor: minor,
    currency,
    expiresAt: instant,
  }),
  'auction.sold': z.object({
    ...base,
    buyerId: id,
    finalPriceMinor: minor,
    currency,
    orderId: id,
    viaSecondChance: z.boolean(),
  }),
  'auction.unsold': z.object({
    ...base,
    reason: z.enum(['winner_unpaid', 'second_chance_unpaid']),
  }),
  'auction.cancelled': z.object({
    ...base,
    reason: z.enum(['seller_cancelled', 'stock_hold_failed']),
  }),
} as const;

export type AuctionEventType = keyof typeof auctionEventSchemas;
export type AuctionEventPayload<T extends AuctionEventType> = z.infer<
  (typeof auctionEventSchemas)[T]
>;

/** Reasons allowed in a history row (kept next to the events that mirror them). */
export { auctionStatusReasonSchema };
