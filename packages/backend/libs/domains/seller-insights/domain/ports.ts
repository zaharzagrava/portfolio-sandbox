import type { BoardUpdate, SaleRow } from './sale-facts';
import type { Period } from './periods';

/**
 * Ports of the seller-insights application layer (S40 D-6): `application/` and the consumers depend on these interfaces and
 * their tokens only; `infra/` binds them to Redis (boards, live counters), PostgreSQL (snapshots, read models) and
 * ClickHouse (sales history).
 */

export type ApplyOutcome = 'applied' | 'duplicate' | 'sealed';
export type VersionOutcome = 'applied' | 'stale';

export interface RankedShop {
  shopId: string;
  revenueMinor: number;
}

export interface ShopPosition {
  rank: number;
  of: number;
  revenueMinor: number;
}

/** The fast board store. Every method rejects with `BoardStoreUnavailableError` when it does not answer in time. */
export interface BoardRepository {
  /** All boards of one order in one period: all or none. Rejects with `RevenueLimitExceededError`. */
  apply(
    period: Period,
    orderId: string,
    saleAt: Date,
    updates: BoardUpdate[],
  ): Promise<ApplyOutcome>;
  top(period: Period, board: string, limit: number): Promise<string[]>;
  /** Rank, size and revenue read in one atomic step; `null` when the shop has no entry. */
  position(
    period: Period,
    board: string,
    shopId: string,
  ): Promise<ShopPosition | null>;
  topWithRevenue(
    period: Period,
    board: string,
    limit: number,
  ): Promise<RankedShop[]>;
  size(period: Period, board: string): Promise<number>;
  boards(period: Period): Promise<string[]>;
  isSealed(period: Period): Promise<boolean>;
  seal(period: Period): Promise<void>;
  /** Every trace of a shop on every board of every period. */
  removeShop(shopId: string): Promise<void>;
}

export interface SnapshotRow {
  rank: number;
  shopId: string;
  shopName: string | null;
  revenueMinor: number;
}

export interface SnapshotPage {
  rows: SnapshotRow[];
  participants: number;
}

export interface SnapshotRepository {
  /** The period has at least one stored board. */
  isFrozen(periodId: string): Promise<boolean>;
  /** Replaces one board atomically: a concurrent reader sees the old or the new set, never an empty or partial one. */
  replaceBoard(
    periodId: string,
    board: string,
    rows: SnapshotRow[],
    participants: number,
  ): Promise<void>;
  top(periodId: string, board: string, limit: number): Promise<SnapshotPage>;
  position(
    periodId: string,
    board: string,
    shopId: string,
  ): Promise<ShopPosition | null>;
  frozenPeriodIds(kind: 'week' | 'month'): Promise<Set<string>>;
  /** Deletes the shop's rows and renumbers what is left of each affected board. */
  removeShop(shopId: string): Promise<void>;
}

export interface LiveBucket {
  checkouts: number;
  orders: number;
  units: number;
  revenue: number;
}

export interface LiveIncrement {
  shopId: string;
  checkouts?: number;
  orders?: number;
  units?: number;
  revenueMinor?: number;
}

export type LiveOutcome = 'applied' | 'duplicate' | 'stale';

export interface LiveCounterRepository {
  /** The "already seen" mark and the increments of one event for one shop, in one atomic step. */
  apply(
    eventId: string,
    kind: 'reserved' | 'paid',
    second: number,
    nowSecond: number,
    increment: LiveIncrement,
  ): Promise<LiveOutcome>;
  /** The 60 one-second buckets ending at `endSecond`, oldest first. */
  window(shopId: string, endSecond: number): Promise<LiveBucket[]>;
  removeShop(shopId: string): Promise<void>;
}

export interface ShopName {
  name: string;
  slug: string;
}

export interface ShopDirectory {
  namesOf(shopIds: string[]): Promise<Map<string, ShopName>>;
  upsert(shop: {
    shopId: string;
    name: string;
    slug: string;
    shopVersion: number;
  }): Promise<VersionOutcome>;
  remove(shopId: string): Promise<void>;
}

export interface ProductCategoryDirectory {
  /** Only products with a known category appear in the result. */
  categoriesOf(productIds: string[]): Promise<Map<string, string>>;
  upsert(product: {
    productId: string;
    shopId: string;
    /** `null` keeps the last known category (a deleted product). */
    category: string | null;
    productVersion: number;
  }): Promise<VersionOutcome>;
  removeByShop(shopId: string): Promise<void>;
}

export interface RefundShare {
  shopId: string;
  amountMinor: number;
}

export interface MinutePoint {
  minute: Date;
  orders: number;
  units: number;
  revenueMinor: number;
}

export interface DayPoint {
  day: string;
  revenueMinor: number;
  orders: number;
  refundedMinor: number;
}

export interface SalesWindow {
  revenueMinor: number;
  orders: number;
  unitsSold: number;
  uniqueBuyers: number;
  refundsCount: number;
  refundedMinor: number;
  daily: DayPoint[];
  topProducts: Array<{
    productId: string;
    title: string;
    revenueMinor: number;
    unitsSold: number;
  }>;
}

/** The exact sales history (analytics store). Every method rejects with `AnalyticsStoreUnavailableError` on failure or timeout. */
export interface SalesHistoryRepository {
  insertSales(rows: SaleRow[]): Promise<void>;
  insertRefunds(
    rows: Array<{
      shopId: string;
      orderId: string;
      amountMinor: number;
      refundedAt: Date;
    }>,
  ): Promise<void>;
  /** What each shop recorded for the order (sum of its lines). */
  recordedShares(orderId: string): Promise<RefundShare[]>;
  today(
    shopId: string,
    from: Date,
    to: Date,
  ): Promise<{
    orders: number;
    units: number;
    revenueMinor: number;
    series: MinutePoint[];
  }>;
  window(shopId: string, from: Date, to: Date): Promise<SalesWindow>;
  removeShop(shopId: string): Promise<void>;
}

export const BOARD_REPOSITORY = Symbol('SELLER_INSIGHTS_BOARD_REPOSITORY');
export const SNAPSHOT_REPOSITORY = Symbol(
  'SELLER_INSIGHTS_SNAPSHOT_REPOSITORY',
);
export const LIVE_COUNTER_REPOSITORY = Symbol(
  'SELLER_INSIGHTS_LIVE_COUNTER_REPOSITORY',
);
export const SALES_HISTORY_REPOSITORY = Symbol(
  'SELLER_INSIGHTS_SALES_HISTORY_REPOSITORY',
);
export const SHOP_DIRECTORY = Symbol('SELLER_INSIGHTS_SHOP_DIRECTORY');
export const PRODUCT_CATEGORY_DIRECTORY = Symbol(
  'SELLER_INSIGHTS_PRODUCT_CATEGORY_DIRECTORY',
);
