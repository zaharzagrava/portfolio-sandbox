/** Timings and limits of the dispatcher (S20 FR-015, FR-018, FR-019), in one place so the services and tests agree. */

/** An offer lives this long (FR-015). */
export const OFFER_TTL_MS = 15_000;
/** The pre-guard outlives the offer a little, so a slow expiry never frees the courier early. */
export const OFFER_GUARD_TTL_MS = 20_000;
/** An empty search schedules its retry this far ahead (FR-019). */
export const RETRY_DELAY_MS = 20_000;
/** Attempts a delivery gets: offers, declines, timeouts and empty searches all consume one (FR-019). */
export const MAX_ATTEMPTS = 8;
/** The recovery job takes at most this many overdue deliveries per tick (FR-018). */
export const RECOVERY_BATCH = 100;
/**
 * A recovery claim moves the due time this far ahead, so a second tick (or another instance) does not take the same
 * row while its effects run outside the transaction; a crashed tick leaves the row to the next one after the lease.
 */
export const RECOVERY_LEASE_MS = 30_000;

/** Pickup and drop-off may be this far apart (straight line, metres): "same-day local" (FR-032). */
export const MAX_ROUTE_M = 30_000;
/** A shop has at most this many open deliveries (FR-032); counted under the shop's advisory lock. */
export const MAX_OPEN_DELIVERIES = 200;
/** Geohash precision of a surge cell (R-7). */
export const SURGE_CELL_PRECISION = 5;
/** At most one `courier_position` push per delivery inside this window (FR-040, AS-47). */
export const POSITION_PUSH_WINDOW_MS = 2_000;
/** A timer message for a city another instance owns is handed back at most this many times, then handled here (FR-043). */
export const MAX_HAND_BACKS = 3;
/** Delay of a hand-back (SQS delays are whole seconds; the spec allows at most 2 s). */
export const HAND_BACK_DELAY_SECONDS = 1;
/** The surge map of a city expires this long after its computation (FR-042). */
export const SURGE_TTL_SECONDS = 180;

/** Delivery milestones after which the order is told (FR-046), in the order the order service needs them. */
export const WRITE_BACK_STEPS = ['ASSIGNED', 'PICKED_UP', 'DELIVERED'] as const;
export type WriteBackStep = (typeof WRITE_BACK_STEPS)[number];

/** The job that tells the order about a milestone (declared with its payload contract in `infra/delivery-jobs.ts`). */
export const ORDER_LIFECYCLE_JOB = 'fulfilment.apply-order-lifecycle' as const;
/** Idempotency key of one write-back: a transition enqueues at most one job, a re-drive finds the same key. */
export const orderLifecycleJobKey = (deliveryId: string, status: string) =>
  `fulfilment-order-lifecycle:${deliveryId}:${status}`;

/** Reasons recorded on a cancelled delivery by the system (shop cancels carry the shop's own text). */
export const SYSTEM_CANCEL_REASONS = {
  noCourier: 'no_courier_available',
  orderCancelled: 'order_cancelled',
  shopDeleted: 'shop_deleted',
} as const;

/** History details of an offer that ended without the courier answering. */
export const OFFER_LAPSE_DETAILS = {
  timeout: 'timeout',
  courierOffline: 'courier_offline',
  declined: 'declined',
} as const;

/** The history note added to a delivery that cannot be cancelled because the parcel is already on its way. */
export const IN_TRANSIT_NOTE = 'order_cancelled_in_transit';
/** Same for a deleted shop: its parcel on its way is delivered, the delivery is not cancelled. */
export const SHOP_DELETED_IN_TRANSIT_NOTE = 'shop_deleted_in_transit';
