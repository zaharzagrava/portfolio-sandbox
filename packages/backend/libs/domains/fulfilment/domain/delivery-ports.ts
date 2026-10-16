import type {
  CourierStatus,
  CourierVehicle,
  DeliveryStatusValue,
  GeoPoint,
  OfferTimeoutMessage,
} from '@marketplace-sandbox/contracts';
import type { ActorKind, DeliveryCommand } from './delivery-state';

/**
 * Ports of the delivery capability (S20 D-6, A24, A32): `application/` talks to these, the `infra/` adapters implement
 * them. Writes join the caller's `TransactionRunner.run` scope through CLS, so no method takes a transaction argument;
 * a method marked "in a transaction" refuses to run outside one. Nothing here reads a clock: every method that depends
 * on time takes `now` (epoch ms for comparisons with positions, `Date` for stored timestamps) from the caller (`CLOCK`).
 */

// ---------------------------------------------------------------- records

export interface CourierRecord {
  id: string;
  city: string;
  vehicle: CourierVehicle;
  status: CourierStatus;
  createdAt: Date;
}

export interface DeliveryRecord {
  id: string;
  shopId: string;
  orderId: string;
  buyerId: string;
  city: string;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  status: DeliveryStatusValue;
  courierId: string | null;
  attempt: number;
  feeMinor: number;
  currency: string;
  /** Multiplier as stored (`1`, `1.25` ... `3`); the money path uses hundredths from `surge-fee.ts`. */
  surge: number;
  nextActionAt: Date | null;
  cancelReason: string | null;
  /** Last status told to the order (`ASSIGNED`, `PICKED_UP`, `DELIVERED`) or null. */
  orderSyncedStatus: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type OfferStatus =
  'OFFERED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'WITHDRAWN';

export interface OfferRecord {
  id: string;
  deliveryId: string;
  courierId: string;
  attempt: number;
  status: OfferStatus;
  offeredAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
}

export interface DeliveryHistoryRecord {
  id: string;
  deliveryId: string;
  /** `null` for the creation row. */
  from: string | null;
  to: DeliveryStatusValue;
  actorKind: ActorKind;
  actorId: string | null;
  detail: string | null;
  version: number;
  at: Date;
}

export interface DeliverableOrderRecord {
  orderId: string;
  buyerId: string;
  shopIds: string[];
  currency: string | null;
  status: 'PAID' | 'CANCELLED';
  orderVersion: number;
  updatedAt: Date;
}

export interface TrackPoint {
  lat: number;
  lng: number;
  ts: number;
  accuracy?: number;
}

export interface LivePosition {
  lat: number;
  lng: number;
  /** Epoch ms of the newest accepted point. */
  ts: number;
}

// ------------------------------------------------------------ repositories

export type RegisterOutcome = 'created' | 'updated' | 'busy';
export type AvailabilityOutcome = 'changed' | 'unchanged' | 'busy';

export interface CourierSelfRecord {
  courier: CourierRecord;
  liveOffer: {
    deliveryId: string;
    pickup: GeoPoint;
    dropoff: GeoPoint;
    feeMinor: number;
    currency: string;
    expiresAt: Date;
  } | null;
  activeDelivery: { deliveryId: string; status: DeliveryStatusValue } | null;
}

export interface CourierRepository {
  /**
   * Upsert. City or vehicle change only `WHERE status <> 'BUSY'` and no live offer; otherwise `busy` and nothing
   * changes. A first registration is `created`; the row is `OFFLINE`.
   */
  register(
    id: string,
    city: string,
    vehicle: CourierVehicle,
    now: Date,
  ): Promise<{
    outcome: RegisterOutcome;
    courier: CourierRecord;
    /** City before an `updated` change of city (the caller moves the cache entries), else `null`. */
    previousCity: string | null;
  }>;
  find(id: string): Promise<CourierRecord | null>;
  /**
   * The profile with the offer held now (`OFFERED` and `expiresAt > now`) and the `ASSIGNED|PICKED_UP` delivery, in
   * one read (`GET /couriers/me`). `null` when the user has no courier profile.
   */
  selfView(id: string, now: Date): Promise<CourierSelfRecord | null>;
  /** One conditional `UPDATE ... WHERE status IN (...)`; `null` when the user has no courier profile. */
  setAvailability(
    id: string,
    available: boolean,
  ): Promise<{ outcome: AvailabilityOutcome; courier: CourierRecord } | null>;
  /** `AVAILABLE -> BUSY`, in a transaction (accept). False when the courier was not `AVAILABLE`. */
  markBusy(id: string): Promise<boolean>;
  /** `BUSY -> AVAILABLE`, in a transaction (delivered, cancelled while assigned). */
  markAvailable(id: string): Promise<boolean>;
  /** The stored profiles of `ids` (one query; unknown ids are absent). Eligibility judges the stored status. */
  findMany(ids: readonly string[]): Promise<CourierRecord[]>;
  /** A city is served when at least one courier is registered in it. */
  isCityServed(city: string): Promise<boolean>;
  /** Distinct cities of the `Courier` rows (the surge job and recovery iterate these). */
  listCities(): Promise<string[]>;
}

export interface NewDelivery {
  shopId: string;
  orderId: string;
  buyerId: string;
  city: string;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  feeMinor: number;
  currency: string;
  surge: number;
}

export type InsertDeliveryResult =
  | { outcome: 'created'; delivery: DeliveryRecord }
  | { outcome: 'already_open' }
  | { outcome: 'already_completed' };

export interface TransitionRequest {
  deliveryId: string;
  /** Optimistic guard for the dispatcher: the row must still have this `version` (it moves on with every transition). */
  expectedVersion?: number;
  /** Carries the actor kind; `decide` of `delivery-state.ts` gives the allowed source statuses. */
  command: DeliveryCommand;
  actorId: string | null;
  detail?: string;
  now: Date;
  /** Set on the row with the status change. `undefined` keeps the column, `null` clears it. */
  set?: {
    courierId?: string | null;
    attempt?: number;
    nextActionAt?: Date | null;
    cancelReason?: string | null;
  };
}

/** The row after a move and the status it moved from (cancel effects depend on it). */
export type TransitionedDelivery = DeliveryRecord & {
  previousStatus: DeliveryStatusValue;
};

export interface ShopListQuery {
  status?: DeliveryStatusValue;
  limit: number;
  /** Keyset position of the last row of the previous page. */
  after?: { createdAt: Date; id: string };
}

export interface DeliveryRepository {
  /**
   * In a transaction: inserts the `REQUESTED` row, the creation history row (`from = null`) and the
   * `delivery.status_changed` outbox event. The partial unique index on `(orderId, shopId)` maps to
   * `already_open` / `already_completed`; every other constraint error propagates.
   */
  insertRequested(input: NewDelivery, now: Date): Promise<InsertDeliveryResult>;
  /** In a transaction: `pg_advisory_xact_lock(hashtext(shopId))`, then the number of the shop's open deliveries. */
  lockShopAndCountOpen(shopId: string): Promise<number>;

  /** Internal read for services (no principal): never returned to a caller without a role check. */
  findById(
    id: string,
    options?: { forUpdate?: boolean },
  ): Promise<DeliveryRecord | null>;
  /** Buyer reads: the buyer is in the predicate. */
  findForBuyer(id: string, buyerId: string): Promise<DeliveryRecord | null>;
  listForBuyerByOrder(
    orderId: string,
    buyerId: string,
  ): Promise<DeliveryRecord[]>;
  /** The assigned courier, or the courier holding the live offer (judged by `now`). */
  findForCourier(
    id: string,
    courierId: string,
    now: Date,
  ): Promise<{ delivery: DeliveryRecord; offer: OfferRecord | null } | null>;
  /** Shop reads and cancel: the shop is in the predicate. */
  findForShop(shopId: string, id: string): Promise<DeliveryRecord | null>;
  listForShop(shopId: string, query: ShopListQuery): Promise<DeliveryRecord[]>;
  history(deliveryId: string): Promise<DeliveryHistoryRecord[]>;

  /**
   * In a transaction: the one conditional write of every move. `UPDATE ... WHERE id AND status IN (from)` asserting
   * one row, `version + 1`, one history row with actor kind and id, and an outbox `delivery.status_changed` when the
   * new status is a milestone (`ASSIGNED`, `PICKED_UP`, `DELIVERED`, `CANCELLED`; never for offer churn).
   * `accept` stores the courier; `pickUp` and `deliver` carry the courier in the predicate; leaving `REQUESTED` /
   * `OFFERED` clears `nextActionAt` unless `set` gives one; `cancel` stores its reason as `cancelReason`. Throws
   * `CourierBusyError` when the unique index on the active assignment refuses `accept`.
   * Returns the updated row, or `null` when the delivery was not in an allowed source status (lost the race).
   */
  transition(request: TransitionRequest): Promise<TransitionedDelivery | null>;
  /** In a transaction: moves the due time of an open delivery without a status change (recovery claims a row). */
  deferAction(deliveryId: string, nextActionAt: Date): Promise<void>;
  /**
   * An empty search consumes an attempt: `attempt = attempt + 1` and `nextActionAt` in one conditional update,
   * `WHERE status = 'REQUESTED' AND attempt = :expectedAttempt`. `null` when the delivery moved on.
   */
  consumeEmptySearch(
    deliveryId: string,
    expectedAttempt: number,
    nextActionAt: Date,
    now: Date,
  ): Promise<DeliveryRecord | null>;
  /** A history row without a status change (`order_cancelled_in_transit`). */
  addNote(
    deliveryId: string,
    actorKind: ActorKind,
    detail: string,
    now: Date,
  ): Promise<void>;

  /**
   * In a transaction: the oldest `REQUESTED|OFFERED` delivery with `nextActionAt <= now`, `FOR UPDATE SKIP LOCKED`,
   * limited to `ownedCities` (`null` = every city). `null` when none is due.
   */
  lockNextOverdue(
    now: Date,
    ownedCities: readonly string[] | null,
  ): Promise<DeliveryRecord | null>;
  /** Open deliveries (`REQUESTED|OFFERED|ASSIGNED|PICKED_UP`) of an order, for `order.cancelled`. */
  listOpenByOrder(orderId: string): Promise<DeliveryRecord[]>;
  /**
   * At most `limit` open deliveries of a shop ordered by id, after `afterId` when given, for `tenancy.shop_deleted`
   * (the consumer pages with the last id, because `PICKED_UP` rows stay open).
   */
  listOpenByShop(
    shopId: string,
    limit: number,
    afterId?: string,
  ): Promise<DeliveryRecord[]>;

  /** Deliveries whose status is ahead of `orderSyncedStatus`, for the write-back re-drive. */
  listNeedingOrderSync(limit: number): Promise<DeliveryRecord[]>;
  /** `orderSyncedStatus` moves forward only. */
  markOrderSynced(deliveryId: string, status: string, now: Date): Promise<void>;
  /** Couriers with more than one live offer or active assignment (derived from stored state, must be 0). */
  countDoubleAssignments(): Promise<number>;
}

export type AcceptOfferResult =
  | { outcome: 'accepted'; offer: OfferRecord }
  /** The offer exists, is `OFFERED`, but `expiresAt <= now` by the injected clock. */
  | { outcome: 'expired' }
  /** No live offer for this courier: never offered, or already `DECLINED|EXPIRED|WITHDRAWN|ACCEPTED`. */
  | { outcome: 'not_active'; previous: OfferRecord | null };

export interface OfferRepository {
  /**
   * In a transaction. `null` when the store of record refused: the courier already holds a live offer, or was offered
   * this delivery before (`(deliveryId, courierId)` unique). Only these two constraints map to `null`.
   */
  insertOffer(input: {
    deliveryId: string;
    courierId: string;
    attempt: number;
    offeredAt: Date;
    expiresAt: Date;
  }): Promise<OfferRecord | null>;
  findLive(deliveryId: string): Promise<OfferRecord | null>;
  /** The courier's live offer by `now`, if any (for `GET /couriers/me`). */
  findLiveForCourier(courierId: string, now: Date): Promise<OfferRecord | null>;
  /** Most recent offer record of the pair, any status. */
  findForCourier(
    deliveryId: string,
    courierId: string,
  ): Promise<OfferRecord | null>;
  /** Every courier ever offered this delivery (permanent exclusion). */
  offeredCourierIds(deliveryId: string): Promise<ReadonlySet<string>>;
  /** Of `courierIds`, those holding an `OFFERED` record. */
  withLiveOffer(courierIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** In a transaction: `OFFERED -> ACCEPTED` only while `expiresAt > now` (the injected clock, not SQL `now()`). */
  accept(
    deliveryId: string,
    courierId: string,
    now: Date,
  ): Promise<AcceptOfferResult>;
  /** In a transaction: `OFFERED -> DECLINED|EXPIRED|WITHDRAWN`. `null` when the offer was not `OFFERED`. */
  close(
    deliveryId: string,
    courierId: string,
    to: 'DECLINED' | 'EXPIRED' | 'WITHDRAWN',
    now: Date,
  ): Promise<OfferRecord | null>;
}

export type DeliverableOrderWriteResult = 'applied' | 'ignored';

export interface DeliverableOrderStore {
  find(orderId: string): Promise<DeliverableOrderRecord | null>;
  /** Upsert guarded by `orderVersion`: higher wins; equal or lower, and a `CANCELLED` row, are `ignored`. */
  applyPaid(
    input: {
      orderId: string;
      buyerId: string;
      shopIds: string[];
      currency: string;
      orderVersion: number;
    },
    now: Date,
  ): Promise<DeliverableOrderWriteResult>;
  /** Cancelled before paid creates the row as `CANCELLED`; an older version is `ignored`. */
  applyCancelled(
    input: { orderId: string; buyerId: string; orderVersion: number },
    now: Date,
  ): Promise<DeliverableOrderWriteResult>;
}

// ------------------------------------------------------- caches and queues

export interface GeoHit {
  courierId: string;
  distanceM: number;
  /** Epoch ms of the newest accepted point; freshness is judged by the caller with `isEligible`. */
  positionTs: number;
}

export interface GeoIndex {
  /**
   * One atomic script: the live position changes only for a point newer than the stored one, together with the
   * searchable-set membership (`searchable` = the courier is `AVAILABLE`). Returns whether the position changed and
   * the courier's active delivery id mirrored in the hash ('' -> null).
   */
  applyLocation(input: {
    city: string;
    courierId: string;
    lat: number;
    lng: number;
    ts: number;
    searchable: boolean;
  }): Promise<{ applied: boolean; deliveryId: string | null }>;
  /** Mirrors status and active delivery; the set membership follows (`AVAILABLE` with a known position only). */
  setStatus(
    city: string,
    courierId: string,
    status: CourierStatus,
    deliveryId: string | null,
  ): Promise<void>;
  removeSearchable(city: string, courierId: string): Promise<void>;
  /** Searchable couriers within `radiusM` of `center`, nearest first, at most `limit`. */
  search(
    city: string,
    center: GeoPoint,
    radiusM: number,
    limit: number,
  ): Promise<GeoHit[]>;
  position(city: string, courierId: string): Promise<LivePosition | null>;
  /** Searchable couriers per geohash cell whose position is newer than `freshSince` (surge supply). */
  searchableByCell(
    city: string,
    precision: number,
    freshSince: number,
  ): Promise<Map<string, number>>;
  /** Drops members whose position is older than `staleBefore`; returns how many (recovery job). */
  pruneStale(city: string, staleBefore: number): Promise<number>;
}

export interface OfferGuard {
  /** Cheap `SET NX PX` pre-guard under the `{city}` tag. Loss or failure is tolerated (the store of record decides). */
  tryAcquire(
    city: string,
    courierId: string,
    deliveryId: string,
    ttlMs: number,
  ): Promise<boolean>;
  release(city: string, courierId: string, deliveryId: string): Promise<void>;
}

export interface SurgeStore {
  /** Surge in hundredths for the cell; `null` when absent or expired (read as 1.00). */
  read(city: string, cell: string): Promise<number | null>;
  /** Replaces the city's map; entries expire after `ttlSeconds`. */
  write(
    city: string,
    surgeByCell: ReadonlyMap<string, number>,
    ttlSeconds: number,
  ): Promise<void>;
  /** Counts a request at time `now` (10-minute window). */
  recordDemand(city: string, cell: string, now: number): Promise<void>;
  /** Requests per cell inside the window ending at `now`. */
  demandByCell(city: string, now: number): Promise<Map<string, number>>;
}

export interface DispatchTimers {
  /**
   * Standard queue, no group id, `delaySeconds` 0-900. `courierId = ''` means "retry dispatch". Called after commit;
   * a failure is repaired by the recovery job (the due time is stored on the delivery).
   */
  enqueue(message: OfferTimeoutMessage, delaySeconds: number): Promise<void>;
}

export type OrderCommand =
  | { type: 'startFulfilment' }
  | { type: 'ship'; trackingCode: string }
  | { type: 'deliver' };

export type OrderLifecycleOutcome =
  | 'applied'
  /** `InvalidOrderTransitionError` while the order is already at or past the target. */
  | 'already_reached'
  /** `InvalidOrderTransitionError` with the order behind the target, or any other permanent refusal. */
  | 'invalid_transition'
  | 'order_not_found';

export interface OrderLifecyclePort {
  /** Transient failures throw (the job retries); the four outcomes above are final. */
  apply(orderId: string, command: OrderCommand): Promise<OrderLifecycleOutcome>;
}

export interface TrackStore {
  /**
   * Conditional put on `(courierId#day, ts)`, 90-day expiry, unprocessed items retried with exponential backoff and
   * full jitter. Throws when the retries are exhausted (nothing partial is acknowledged by the caller).
   */
  putPoints(
    courierId: string,
    deliveryId: string | null,
    points: readonly TrackPoint[],
  ): Promise<void>;
}

export interface RingRegistry {
  /** Heartbeat every 10 s, expiry 30 s. */
  heartbeat(instanceId: string, now: number): Promise<void>;
  leave(instanceId: string): Promise<void>;
  /** Live instance ids at `now`; an empty list means "every instance processes every city". */
  liveInstances(now: number): Promise<string[]>;
}

/** Limits the live position push of one delivery (S20 FR-040): at most one per window, measured on the caller's clock. */
export interface PositionThrottle {
  /**
   * True when a push may go out now: no push was claimed within the last `windowMs` (a closed window, so a claim at
   * `t` blocks every claim up to and including `t + windowMs`). `now` is epoch ms from `CLOCK`.
   */
  claim(
    city: string,
    deliveryId: string,
    now: number,
    windowMs: number,
  ): Promise<boolean>;
}

export interface RealtimeAccessPort {
  /** One query with the principal in the predicate: the buyer or the assigned courier. */
  canSubscribe(deliveryId: string, userId: string): Promise<boolean>;
}

/**
 * Called when a courier goes `OFFLINE`: withdraws the live offer, if any, and dispatches the delivery to the next
 * courier at once (FR-003, AS-26). Bound by the dispatch part (T044/T062); unbound, going offline only changes the shift.
 */
export interface CourierOfflineHook {
  onCourierOffline(courierId: string): Promise<void>;
}

// ----------------------------------------------------------------- tokens
export const COURIER_OFFLINE_HOOK = Symbol('COURIER_OFFLINE_HOOK');
export const COURIER_REPOSITORY = Symbol('COURIER_REPOSITORY');
export const DELIVERY_REPOSITORY = Symbol('DELIVERY_REPOSITORY');
export const OFFER_REPOSITORY = Symbol('OFFER_REPOSITORY');
export const DELIVERABLE_ORDER_STORE = Symbol('DELIVERABLE_ORDER_STORE');
export const GEO_INDEX = Symbol('GEO_INDEX');
export const OFFER_GUARD = Symbol('OFFER_GUARD');
export const SURGE_STORE = Symbol('SURGE_STORE');
export const DISPATCH_TIMERS = Symbol('DISPATCH_TIMERS');
export const ORDER_LIFECYCLE_PORT = Symbol('ORDER_LIFECYCLE_PORT');
export const TRACK_STORE = Symbol('TRACK_STORE');
export const RING_REGISTRY = Symbol('RING_REGISTRY');
export const REALTIME_ACCESS_PORT = Symbol('REALTIME_ACCESS_PORT');
export const POSITION_THROTTLE = Symbol('POSITION_THROTTLE');
