import type { CartLine } from './cart-merge';
import type { CancelReason, OrderStatus } from './order-state';
import type { StockOperationInput } from './stock-operations';

/**
 * Ports of `orders` (I.1, D-6): `application/` depends on these interfaces and on the pure rules of `domain/`; the
 * adapters live in `infra/`. Repository methods join the active transaction (CLS) when there is one.
 */

// ---------------------------------------------------------------- records

export type ShopOrderStatus = 'PENDING' | 'PAID' | 'CANCELLED' | 'REFUNDED';
export type ReservationStatus =
  'REQUESTED' | 'HELD' | 'CONVERTED' | 'RELEASE_PENDING' | 'RELEASED';

export interface OrderRecord {
  id: string;
  userId: string;
  status: OrderStatus;
  totalMinor: number;
  currency: string;
  reservedUntil: Date | null;
  version: number;
  idempotencyKey: string | null;
  requestHash: string | null;
  cancelReason: CancelReason | null;
  paymentRef: string | null;
  createdAt: Date;
}

export interface ItemSnapshotGap {
  id: string;
  productId: string;
  quantity: number;
  unitPriceMinor: number;
  title: string | null;
  lineTotalMinor: number | null;
}

/** One row of the buyer's history: only what the covering index holds. */
export interface OrderListRecord {
  id: string;
  status: OrderStatus;
  totalMinor: number;
  currency: string;
  createdAt: Date;
}

export interface OrderItemRecord {
  productId: string;
  shopId: string | null;
  title: string | null;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  lineTotalMinor: number | null;
}

export interface ShopOrderRecord {
  id: string;
  orderId: string;
  shopId: string | null;
  subtotalMinor: number;
  status: ShopOrderStatus;
}

export interface ReservationRecord {
  id: string;
  orderId: string;
  productId: string;
  shopId: string;
  quantity: number;
  status: ReservationStatus;
  releaseAttempts: number;
  /**
   * Where the units come from: the catalog's stock, a flash sale's fast store (S11), or another capability that holds
   * them itself (`EXTERNAL`, S21: an auction's unit; releasing such a row makes no stock operation).
   */
  source: 'CATALOG' | 'FLASH' | 'POSTGRES' | 'EXTERNAL';
  /** `FLASH`: the claim id. `EXTERNAL`: the holder's reference (the auction id). */
  sourceRef: string | null;
  flashSaleId: string | null;
}

export interface HistoryRecord {
  status: OrderStatus;
  fromStatus: OrderStatus | null;
  reason: string | null;
  actor: string | null;
  at: Date;
}

export interface NewOrder {
  id: string;
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  refCode: string | null;
  totalMinor: number;
  currency: string;
  now: Date;
  items: Array<
    OrderItemRecord & {
      title: string;
      lineTotalMinor: number;
      shopId: string;
      /** A drop line: its units are already claimed in the fast store; the reservation row starts `HELD` (S11). */
      flash?: { flashSaleId: string; claimId: string };
      /** Units held by another capability (S21): the reservation row starts `HELD` with source `EXTERNAL` and this reference. */
      external?: { ref: string };
    }
  >;
  shopOrders: Array<{ shopId: string; subtotalMinor: number }>;
  /** When the holds of a drop line or an external line expire (the order's hold window); only read for those lines. */
  flashExpiresAt?: Date;
}

// ---------------------------------------------------------------- repositories

export interface OrderRepository {
  /** Inserts the `PENDING` order with items, shop orders, `REQUESTED` reservations and the first history row; `null` when `(userId, idempotencyKey)` already exists. */
  createPending(order: NewOrder): Promise<OrderRecord | null>;
  findById(orderId: string): Promise<OrderRecord | null>;
  /** `WHERE id = :id AND "userId" = :u`: a foreign order is simply absent (III.4). */
  findForUser(orderId: string, userId: string): Promise<OrderRecord | null>;
  findByKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<OrderRecord | null>;
  items(orderId: string): Promise<OrderItemRecord[]>;
  /**
   * Conditional move (`… AND status = :from`), `version + 1`; `null` when no row matched.
   * `patch` sets the columns the move owns.
   */
  move(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    patch: {
      reservedUntil?: Date | null;
      cancelReason?: CancelReason | null;
      paymentRef?: string | null;
    },
    now: Date,
  ): Promise<OrderRecord | null>;
  /**
   * The buyer's orders newest first with the id as tiebreaker, strictly after `after` when given; never the orders
   * cancelled for `out_of_stock` (they were never reserved). Scoped to `userId` inside the statement.
   */
  pageForUser(
    userId: string,
    limit: number,
    after: { createdAt: string; id: string } | null,
  ): Promise<OrderListRecord[]>;
  /** Items that still lack a title or a line total (orders from before the snapshot columns), by id, at most `limit`. */
  itemsMissingSnapshot(limit: number): Promise<ItemSnapshotGap[]>;
  /** Fills only what is still empty, so two runs of the backfill agree. */
  fillItemSnapshot(
    itemId: string,
    title: string,
    lineTotalMinor: number,
  ): Promise<void>;
  /** Items without a shop id: reported by the backfill, never guessed. */
  countItemsWithoutShop(): Promise<number>;
  /** Orders `RESERVED` whose hold ended at or before `now`, oldest first, `FOR UPDATE SKIP LOCKED`. */
  expiredReserved(now: Date, limit: number): Promise<string[]>;
  /** Orders `PENDING` created before `before`, oldest first. */
  stalePending(before: Date, limit: number): Promise<string[]>;
}

/** A shop's slice of an order as the seller's list shows it. */
export interface ShopOrderListRecord {
  id: string;
  orderId: string;
  status: ShopOrderStatus;
  subtotalMinor: number;
  currency: string;
  buyerId: string;
  createdAt: Date;
}

/** An item line with the shop order it belongs to. */
export interface OrderLineRecord extends OrderItemRecord {
  orderId: string;
  shopOrderId: string;
}

export interface ShopOrderRepository {
  /** The shop's slices newest first with the id as tiebreaker, strictly after `after`; every table is filtered by `shopId` in the statement. */
  pageForShop(
    shopId: string,
    status: ShopOrderStatus | null,
    limit: number,
    after: { createdAt: string; id: string } | null,
  ): Promise<ShopOrderListRecord[]>;
  /** One slice by id, only if it belongs to `shopId` (one statement); `null` for another shop's or an unknown id. */
  oneForShop(
    shopId: string,
    shopOrderId: string,
  ): Promise<ShopOrderListRecord | null>;
  /** Item lines of the orders in one statement; `shopId` restricts them to one shop's lines. */
  lines(orderIds: string[], shopId: string | null): Promise<OrderLineRecord[]>;
  forOrder(orderId: string): Promise<ShopOrderRecord[]>;
  setStatus(orderId: string, status: ShopOrderStatus, now: Date): Promise<void>;
}

export interface ReservationRepository {
  forOrder(orderId: string): Promise<ReservationRecord[]>;
  /** Sets `fromStatuses → to` for the order's reservations; returns how many changed. */
  transitionAll(
    orderId: string,
    from: ReservationStatus[],
    to: ReservationStatus,
    patch?: { expiresAt?: Date; nextReleaseAt?: Date | null },
  ): Promise<number>;
  /** `RELEASE_PENDING` rows due at `now`, oldest first, with their shop id, `SKIP LOCKED`. */
  releasePending(now: Date, limit: number): Promise<ReservationRecord[]>;
  markReleased(id: string): Promise<void>;
  scheduleRetry(
    id: string,
    attempts: number,
    nextReleaseAt: Date,
  ): Promise<void>;
  countReleasePending(): Promise<number>;
}

export interface OrderHistoryRepository {
  append(entry: {
    orderId: string;
    from: OrderStatus | null;
    to: OrderStatus;
    reason: string | null;
    actor: string | null;
    amountMinor?: number;
    at: Date;
  }): Promise<void>;
  timeline(orderId: string): Promise<HistoryRecord[]>;
  /** Whether a row with this reason and actor exists (dedupes rows a redelivered job would write twice). */
  has(orderId: string, reason: string, actor: string): Promise<boolean>;
}

// ---------------------------------------------------------------- stores and edges

export interface CartStore {
  /** Lines not expired at `now`, in `(addedAt, productId)` order. */
  list(cartId: string, now: Date): Promise<CartLine[]>;
  /** `ok`, or `line_limit` when the product is new and the cart holds the maximum. Quantity `0` removes. */
  setLine(
    cartId: string,
    productId: string,
    quantity: number,
    now: Date,
  ): Promise<'ok' | 'line_limit'>;
  /** Atomic, idempotent: the guest quantities are added exactly once, the guest cart is gone afterwards. */
  merge(
    guestCartId: string,
    userCartId: string,
    now: Date,
  ): Promise<{ lines: CartLine[]; droppedLines: number }>;
  /** Removes exactly what checkout consumed: a line is deleted only when its quantity still equals the one read. */
  removeConsumed(
    cartId: string,
    consumed: Array<{ productId: string; quantity: number }>,
    now: Date,
  ): Promise<void>;
}

export interface CheckoutLock {
  /** A token when the buyer's lock was free, `null` when another checkout holds it. */
  acquire(userId: string): Promise<string | null>;
  release(userId: string, token: string): Promise<void>;
}

export interface CatalogProduct {
  id: string;
  shopId: string | null;
  title: string;
  priceMinor: number;
  currency: string;
  status: 'ACTIVE' | 'ARCHIVED';
  isSandbox: boolean;
  category: string;
}

export type StockOutcome =
  | { outcome: 'applied' }
  | { outcome: 'rejected'; insufficient: string[]; unavailable: string[] };

export interface ProductCatalogPort {
  /** Unknown ids are absent. Times out after `orders_catalog_timeout_ms`. */
  getProducts(ids: string[]): Promise<Map<string, CatalogProduct>>;
}

export interface ShopSummary {
  id: string;
  status: string;
  isSandbox: boolean;
}

export interface ShopDirectoryPort {
  getShops(ids: string[]): Promise<Map<string, ShopSummary>>;
}

export interface DiscountLine {
  productId: string;
  shopId: string;
  category: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface ShopDiscountsPort {
  /** Per-shop discount amounts; any failure is reported by throwing and the caller falls back to catalogue prices. */
  evaluate(
    lines: DiscountLine[],
  ): Promise<Array<{ shopId: string; discountMinor: number }>>;
}

/** Where stock for a reservation comes from; the catalog today, flash-sale buckets later (S11). */
export interface ReservationSource {
  reserve(operations: StockOperationInput[]): Promise<StockOutcome>;
  /** Returns held units; a compensation is its own operation (never a replay of the reserve). */
  release(operations: StockOperationInput[]): Promise<StockOutcome>;
}

export interface RealtimePort {
  /** Best effort: failures are logged and counted by the adapter, never thrown. */
  pushOrderStatus(
    userId: string,
    orderId: string,
    status: OrderStatus,
  ): Promise<void>;
}

export interface PaymentStatus {
  status: 'COMPLETED' | 'PENDING' | 'FAILED' | 'REFUNDED' | 'UNKNOWN';
  amountMinor: number;
  currency: string;
}

export interface PaymentStatusPort {
  /** Throws `PaymentStatusUnavailableError` (retryable) when the payments capability cannot answer. */
  getPaymentStatus(paymentRef: string): Promise<PaymentStatus>;
}

export interface RefundCommandPort {
  /** Appends the `orders.refund_requested` message once per `paymentRef` (idempotent). */
  requestRefund(command: {
    orderId: string;
    paymentRef: string;
    amountMinor: number;
    currency: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------- tokens

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
export const SHOP_ORDER_REPOSITORY = Symbol('SHOP_ORDER_REPOSITORY');
export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');
export const ORDER_HISTORY_REPOSITORY = Symbol('ORDER_HISTORY_REPOSITORY');
export const CART_STORE = Symbol('CART_STORE');
export const CHECKOUT_LOCK = Symbol('CHECKOUT_LOCK');
export const PRODUCT_CATALOG = Symbol('PRODUCT_CATALOG');
export const SHOP_DIRECTORY = Symbol('SHOP_DIRECTORY');
export const SHOP_DISCOUNTS = Symbol('SHOP_DISCOUNTS');
export const RESERVATION_SOURCE = Symbol('RESERVATION_SOURCE');
export const REALTIME_PORT = Symbol('REALTIME_PORT');
export const PAYMENT_STATUS = Symbol('PAYMENT_STATUS');
export const REFUND_COMMAND = Symbol('REFUND_COMMAND');
