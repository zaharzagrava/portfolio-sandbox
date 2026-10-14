import { auctionEventSchemas } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * `auctions.events` (key = auctionId → per-auction ordering), contract version 1 (specs/domains/S21-limited-drops/
 * contracts/events.md). Every payload carries `auctionId`, `shopId`, `productId` and `auctionVersion`; the schemas
 * live in `packages/contracts` so consumers (S28, community, S40) parse the same shape. No payload carries a maximum
 * or the reserve amount.
 */
export const AUCTIONS_AGGREGATE = {
  aggregateType: 'auctions',
  retention: 'full-history',
} as const;

export const AuctionCreated = defineEvent(
  'auction.created',
  'auctions',
  1,
  auctionEventSchemas['auction.created'],
);

export const AuctionOpened = defineEvent(
  'auction.opened',
  'auctions',
  1,
  auctionEventSchemas['auction.opened'],
);

export const AuctionBidPlaced = defineEvent(
  'auction.bid_placed',
  'auctions',
  1,
  auctionEventSchemas['auction.bid_placed'],
);

export const AuctionLeaderChanged = defineEvent(
  'auction.leader_changed',
  'auctions',
  1,
  auctionEventSchemas['auction.leader_changed'],
);

export const AuctionClosed = defineEvent(
  'auction.closed',
  'auctions',
  1,
  auctionEventSchemas['auction.closed'],
);

export const AuctionSecondChanceOffered = defineEvent(
  'auction.second_chance_offered',
  'auctions',
  1,
  auctionEventSchemas['auction.second_chance_offered'],
);

export const AuctionSold = defineEvent(
  'auction.sold',
  'auctions',
  1,
  auctionEventSchemas['auction.sold'],
);

export const AuctionUnsold = defineEvent(
  'auction.unsold',
  'auctions',
  1,
  auctionEventSchemas['auction.unsold'],
);

export const AuctionCancelled = defineEvent(
  'auction.cancelled',
  'auctions',
  1,
  auctionEventSchemas['auction.cancelled'],
);

/** The fields every payload carries (the version is the auction's version after the change). */
export const eventBase = (auction: {
  id: string;
  shopId: string;
  productId: string;
  version: number;
}) => ({
  auctionId: auction.id,
  shopId: auction.shopId,
  productId: auction.productId,
  auctionVersion: auction.version,
});
