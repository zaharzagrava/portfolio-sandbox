import type { AuctionStatus, StatusReason } from './auction-state';
import type { BidOutcome } from './proxy-bid';
import type { RunnerUpCandidate } from './runner-up';

/**
 * Ports of `auctions` (I.1, D-6): `application/` depends on these interfaces and on the pure rules of `domain/`; the
 * adapters live in `infra/`. Repository methods join the active transaction (CLS) when there is one.
 */

// ---------------------------------------------------------------- injection tokens

export const AUCTION_REPOSITORY = Symbol('AUCTION_REPOSITORY');
export const BID_REPOSITORY = Symbol('BID_REPOSITORY');
export const PRODUCT_CATALOG = Symbol('AUCTION_PRODUCT_CATALOG');
export const AUCTION_STOCK = Symbol('AUCTION_STOCK');
export const SHOP_MEMBERSHIP = Symbol('AUCTION_SHOP_MEMBERSHIP');
export const ORDER_REQUEST = Symbol('AUCTION_ORDER_REQUEST');
export const AUCTION_VIEW_CACHE = Symbol('AUCTION_VIEW_CACHE');
export const AUCTION_REALTIME = Symbol('AUCTION_REALTIME');
export const AUCTION_SETTINGS = Symbol('AUCTION_SETTINGS');

// ---------------------------------------------------------------- records

export interface AuctionRecord {
  id: string;
  shopId: string;
  productId: string;
  title: string;
  currency: string;
  startingPriceMinor: number;
  minIncrementMinor: number;
  reservePriceMinor: number | null;
  startsAt: Date;
  endsAt: Date;
  originalEndsAt: Date;
  status: AuctionStatus;
  statusReason: StatusReason | null;
  priceMinor: number;
  leaderId: string | null;
  leaderMaxMinor: number | null;
  bidCount: number;
  version: number;
  unitHeld: boolean;
  holdRequestedAt: Date;
  returnPending: boolean;
  winnerId: string | null;
  finalPriceMinor: number | null;
  firstOrderId: string | null;
  winnerOrderId: string | null;
  settlementOrderVersion: number;
  offerExpiresAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewAuction {
  id: string;
  shopId: string;
  productId: string;
  title: string;
  currency: string;
  startingPriceMinor: number;
  minIncrementMinor: number;
  reservePriceMinor: number | null;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  actor: string;
}

export interface BidRecord {
  id: string;
  auctionId: string;
  bidderId: string;
  maxAmountMinor: number;
  outcome: BidOutcome;
  priceAfterMinor: number;
  sequence: number;
  createdAt: Date;
}

export interface NewBid {
  auctionId: string;
  bidderId: string;
  maxAmountMinor: number;
  outcome: BidOutcome;
  priceAfterMinor: number;
  sequence: number;
  createdAt: Date;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface BidPatch {
  priceMinor: number;
  leaderId: string;
  leaderMaxMinor: number;
  endsAt: Date;
  /** The version the caller read under the lock; the update asserts it. */
  expectedVersion: number;
  now: Date;
}

/** Columns a transition may set besides `status`, `statusReason`, `version` (all optional). */
export interface TransitionPatch {
  winnerId?: string | null;
  finalPriceMinor?: number | null;
  closedAt?: Date | null;
  returnPending?: boolean;
  offerExpiresAt?: Date | null;
  winnerOrderId?: string | null;
}

export interface TransitionRequest {
  id: string;
  from: AuctionStatus;
  to: AuctionStatus;
  reason: StatusReason | null;
  patch?: TransitionPatch;
  actor: string;
  at: Date;
}

export interface AuctionRepository {
  /** Inserts the auction, its `null → SCHEDULED` history row; a live auction on the product -> `AuctionExistsForProductError`. */
  create(input: NewAuction): Promise<AuctionRecord>;
  /** `SELECT … FOR UPDATE` (joins the active transaction); null when unknown. */
  lockById(id: string): Promise<AuctionRecord | null>;
  findById(id: string): Promise<AuctionRecord | null>;
  findForShop(shopId: string, id: string): Promise<AuctionRecord | null>;
  listForShop(
    shopId: string,
    query: { status?: AuctionStatus; limit: number; cursor?: string },
  ): Promise<Page<AuctionRecord>>;
  /** Live and recently closed auctions of the products (the public batch read). */
  listPublicByProducts(
    productIds: string[],
    now: Date,
    closedWithinMs: number,
  ): Promise<AuctionRecord[]>;
  /** Conditional `UPDATE … WHERE version = :expectedVersion`, one row asserted. */
  applyBid(id: string, patch: BidPatch): Promise<AuctionRecord>;
  /** Conditional status move + history row in the same transaction; null when the row was not in `from`. */
  transition(request: TransitionRequest): Promise<AuctionRecord | null>;
  markUnitHeld(id: string): Promise<boolean>;
  markUnitReturned(id: string): Promise<boolean>;
  /** Sets the order of the current settlement step (and `firstOrderId` for the winner step). */
  storeOrder(
    id: string,
    step: 'winner' | 'second-chance',
    orderId: string,
  ): Promise<boolean>;
  /** Applies `orderVersion` when it is above the stored one; false when it is not. */
  advanceSettlementVersion(id: string, orderVersion: number): Promise<boolean>;
  findBySettlementOrder(
    orderId: string,
  ): Promise<{ auction: AuctionRecord; role: 'first' | 'current' } | null>;
  /**
   * An awarded auction (`CLOSED` or `SECOND_CHANCE`) whose order ID is not stored yet, for this buyer at this price:
   * the order the command created but whose answer the job has not recorded (research R-05).
   */
  findAwaitingOrder(
    buyerId: string,
    priceMinor: number,
  ): Promise<AuctionRecord | null>;
  /** `OPEN` auctions whose stored end has passed, oldest first, `FOR UPDATE SKIP LOCKED` not needed (read only). */
  findDue(now: Date, limit: number): Promise<string[]>;
  /** `OPEN` auctions whose stored end is before `before` (they should have closed already). */
  countOverdue(before: Date): Promise<number>;
  /** `SCHEDULED` auctions whose unit is held and whose start has passed (the open job was lost or early). */
  findDueToOpen(now: Date, limit: number): Promise<string[]>;
  findHoldPending(olderThan: Date, limit: number): Promise<AuctionRecord[]>;
  findReturnPending(limit: number): Promise<string[]>;
  findClosedWithoutOrder(
    olderThan: Date,
    limit: number,
  ): Promise<AuctionRecord[]>;
}

export interface BidRepository {
  append(bid: NewBid): Promise<BidRecord>;
  /** Price-changing bids (`leading`, `outbid`), newest first. */
  historyPage(
    auctionId: string,
    query: { limit: number; cursor?: string },
  ): Promise<Page<BidRecord>>;
  /** The bidder's highest maximum and whether anything was bid. */
  myBid(
    auctionId: string,
    bidderId: string,
  ): Promise<{ maxAmountMinor: number } | null>;
  /** One row per bidder: their highest maximum and the earliest bid at it. */
  runnerUpCandidates(auctionId: string): Promise<RunnerUpCandidate[]>;
}

// ---------------------------------------------------------------- outbound ports

export interface CatalogProduct {
  id: string;
  shopId: string;
  title: string;
  priceMinor: number;
  currency: string;
  quantity: number;
  status: 'ACTIVE' | 'ARCHIVED';
}

export interface ProductCatalogPort {
  /** The product when it belongs to the shop; null otherwise (existence hidden). */
  getProduct(shopId: string, productId: string): Promise<CatalogProduct | null>;
}

export type StockResult =
  | { ok: true; replayed: boolean }
  | { ok: false; reason: 'insufficient_stock' | 'unavailable' };

export interface AuctionStockPort {
  hold(
    auctionId: string,
    productId: string,
    shopId: string,
  ): Promise<StockResult>;
  /** A new operation, never a compensation of the hold (S05). */
  return(
    auctionId: string,
    productId: string,
    shopId: string,
  ): Promise<StockResult>;
}

export interface ShopMembershipPort {
  /** Any role is a member. Throws `MembershipUnavailableError` on timeout or failure (fail closed). */
  isMember(shopId: string, userId: string): Promise<boolean>;
  /** The members among the users, in one pass. */
  membersAmong(shopId: string, userIds: string[]): Promise<Set<string>>;
}

export type OrderRequest = {
  idempotencyKey: string;
  buyerId: string;
  shopId: string;
  productId: string;
  unitPriceMinor: number;
  currency: string;
  titleSnapshot: string;
  reservedUntil: Date;
  auctionId: string;
  step: 'winner' | 'second-chance';
};

export type OrderRequestResult =
  | { ok: true; orderId: string; replayed: boolean }
  | { ok: false; permanent: true; code: string };

export interface OrderRequestPort {
  /** Throws on a transient failure (the job retries with backoff). */
  request(command: OrderRequest): Promise<OrderRequestResult>;
}

export interface PublicAuctionView {
  auctionId: string;
  productId: string;
  shopId: string;
  title: string;
  currency: string;
  status: AuctionStatus;
  startsAt: string;
  endsAt: string;
  priceMinor: number;
  minimumNextMaxMinor: number;
  bidCount: number;
  hasReserve: boolean;
  reserveMet: boolean;
  leaderAlias: string | null;
  version: number;
  serverTime: string;
}

export interface AuctionViewCachePort {
  getOrLoad(
    auctionId: string,
    loader: () => Promise<PublicAuctionView | null>,
  ): Promise<PublicAuctionView | null>;
  invalidate(auctionId: string): Promise<void>;
}

export interface AuctionRealtimePort {
  publishPrice(message: {
    auctionId: string;
    priceMinor: number;
    leaderAlias: string | null;
    endsAt: string;
    reserveMet: boolean;
    version: number;
    serverTime: string;
  }): Promise<void>;
  publishClosed(message: {
    auctionId: string;
    status: 'CLOSED' | 'UNSOLD';
    finalPriceMinor: number | null;
    version: number;
  }): Promise<void>;
}
