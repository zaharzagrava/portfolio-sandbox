import type {
  AuctionMember,
  AuctionPublic,
} from '@marketplace-sandbox/contracts';
import type { AuctionRecord } from './auction-ports';
import { bidderAlias } from './bidder-alias';
import { isReserveMet, minimumNextMax } from './proxy-bid';

/**
 * The shapes clients see (S21 FR-020, FR-034). Pure. A user ID, a maximum and (outside the seller's own view) the
 * reserve amount never leave through here; the leader is a per-auction alias.
 */
export function leaderAliasOf(
  secret: string,
  auction: Pick<AuctionRecord, 'id' | 'leaderId'>,
): string | null {
  return auction.leaderId
    ? bidderAlias(secret, auction.id, auction.leaderId)
    : null;
}

export function toMemberView(
  auction: AuctionRecord,
  secret: string,
): AuctionMember {
  return {
    id: auction.id,
    shopId: auction.shopId,
    productId: auction.productId,
    title: auction.title,
    currency: auction.currency,
    startingPriceMinor: auction.startingPriceMinor,
    minIncrementMinor: auction.minIncrementMinor,
    reservePriceMinor: auction.reservePriceMinor,
    startsAt: auction.startsAt.toISOString(),
    endsAt: auction.endsAt.toISOString(),
    originalEndsAt: auction.originalEndsAt.toISOString(),
    status: auction.status,
    statusReason: auction.statusReason,
    priceMinor: auction.priceMinor,
    bidCount: auction.bidCount,
    leaderAlias: leaderAliasOf(secret, auction),
    reserveMet: isReserveMet(auction.priceMinor, auction.reservePriceMinor),
    winnerOrderId: auction.winnerOrderId,
    finalPriceMinor: auction.finalPriceMinor,
    version: auction.version,
    createdAt: auction.createdAt.toISOString(),
  };
}

export function toPublicView(
  auction: AuctionRecord,
  secret: string,
  now: Date,
): AuctionPublic {
  return {
    auctionId: auction.id,
    productId: auction.productId,
    shopId: auction.shopId,
    title: auction.title,
    currency: auction.currency,
    status: auction.status,
    startsAt: auction.startsAt.toISOString(),
    endsAt: auction.endsAt.toISOString(),
    priceMinor: auction.priceMinor,
    minimumNextMaxMinor: minimumNextMax(auction),
    bidCount: auction.bidCount,
    hasReserve: auction.reservePriceMinor !== null,
    reserveMet: isReserveMet(auction.priceMinor, auction.reservePriceMinor),
    leaderAlias: leaderAliasOf(secret, auction),
    version: auction.version,
    serverTime: now.toISOString(),
  };
}
