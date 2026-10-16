/** Constants of the booking half of `launch-events` (S22). They are not event settings (spec Assumptions). */

/** A hold lasts exactly 10 minutes from creation (FR-016). */
export const HOLD_MS = 10 * 60_000;
/** An admission token lasts exactly 10 minutes (FR-006). */
export const ADMISSION_TTL_SEC = 600;
/** A ticket whose owner has not polled for this long is skipped and removed (FR-007). */
export const HEARTBEAT_SEC = 120;
export const HEARTBEAT_MS = HEARTBEAT_SEC * 1000;
/** Sub-queues per event: one mega-event's queue would otherwise be a single hot key. */
export const QUEUE_SHARDS = 8;
/** The reconciler runs every minute and repairs drift older than this (AS-41, AS-48). */
export const RECONCILE_GRACE_MS = 120_000;
/** Seats per hold request, and the length of the status gate's life in Redis. */
export const MAX_SEATS_PER_HOLD = 10;
export const GATE_TTL_SEC = 30;
/** Lifetime of derived Redis keys (map, quota, tickets) beyond the event. */
export const DERIVED_KEY_TTL_SEC = 7 * 24 * 3600;
/** Lifetime of a hold record in the ledger after it ended (they are kept, not deleted, FR-019). */
export const HOLD_RECORD_RETENTION_SEC = 30 * 24 * 3600;
/** Longest the confirm waits for a concurrent confirm of the same hold to finish. */
export const CONFIRM_WAIT_MS = 3_000;
/** Seconds a shed or failed call tells the client to wait. */
export const RETRY_AFTER = { full: 5, unavailable: 2 } as const;

export const EXPIRE_HOLD_JOB = 'launch-events.expire-hold' as const;
export const OPEN_SALES_JOB = 'launch-events.open-sales' as const;
export const CLOSE_EVENT_JOB = 'launch-events.close-event' as const;
export const RECONCILE_SEATS_JOB = 'launch-events.reconcile-seats' as const;
export const BOOKING_VOUCHER_QUEUE = 'orders-booking-voucher-requested';

export const holdExpireJobKey = (holdId: string) => `hold-expire:${holdId}`;
export const openSalesJobKey = (eventId: string) => `open-sales:${eventId}`;
export const closeEventJobKey = (eventId: string, reason: string) =>
  `close-event:${eventId}:${reason}`;
export const voucherDedupeKey = (holdId: string) => `booking-voucher:${holdId}`;
