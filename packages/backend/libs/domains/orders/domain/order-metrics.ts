import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of `orders` (S10 A42). Labels are bounded outcomes only: never a user, order or product id (the
 * registry refuses those labels); the ids go to logs and traces.
 */
export const checkoutCounter = MetricsRegistry.counter({
  name: 'orders_checkout_total',
  help: 'Checkouts by outcome (reserved, out_of_stock, price_changed, invalid, unavailable, in_progress, replayed)',
  labels: ['outcome'],
});

export const orderPaidCounter = MetricsRegistry.counter({
  name: 'orders_paid_total',
  help: 'Orders that became PAID (counted after the commit of the move)',
  labels: [],
});

export const reservationExpiredCounter = MetricsRegistry.counter({
  name: 'orders_reservation_expired_total',
  help: 'Holds cancelled because they expired',
  labels: [],
});

export const releasePendingGauge = MetricsRegistry.gauge({
  name: 'orders_reservations_release_pending',
  help: 'Reservations whose stock has not been returned yet',
  labels: [],
});

export const webhookEventCounter = MetricsRegistry.counter({
  name: 'orders_webhook_events_total',
  help: 'Payment webhook events by result (received, duplicate, processed, ignored, unmatched, rejected, failed, invalid_signature)',
  labels: ['result'],
});

export const discountFallbackCounter = MetricsRegistry.counter({
  name: 'orders_discount_fallback_total',
  help: 'Checkouts priced at catalogue prices because the discount source failed (timeout, error, invalid)',
  labels: ['reason'],
});

export const cartCleanupFailedCounter = MetricsRegistry.counter({
  name: 'orders_cart_cleanup_failed_total',
  help: 'Cart clean-ups after checkout that failed',
  labels: [],
});

export const paidAfterCancelCounter = MetricsRegistry.counter({
  name: 'orders_paid_after_cancel_total',
  help: 'Genuine payments that arrived for an already cancelled order',
  labels: [],
});

export const realtimeFailedCounter = MetricsRegistry.counter({
  name: 'orders_realtime_failed_total',
  help: 'Realtime pushes that failed (best effort)',
  labels: [],
});

export const backfillOrphansGauge = MetricsRegistry.gauge({
  name: 'orders_backfill_orphans',
  help: 'Order items still without a shop id',
  labels: [],
});

// ---------------------------------------------------------------- flash sales (S11 AS-42)

export const flashReservationsCounter = MetricsRegistry.counter({
  name: 'flash_sale_reservations_total',
  help: 'Drop reservations by result (reserved, sold_out, limit_exceeded, not_open)',
  labels: ['result'],
});

export const flashAdmissionRejectedCounter = MetricsRegistry.counter({
  name: 'flash_sale_admission_rejected_total',
  help: 'Attempts held back by the sale admission allowance',
  labels: [],
});

export const flashStockRemainingGauge = MetricsRegistry.gauge({
  name: 'flash_sale_stock_remaining',
  help: 'Units left in the fast store of a loaded sale, refreshed at each verification',
  labels: ['saleId'],
});

export const flashStockDriftCounter = MetricsRegistry.counter({
  name: 'flash_sale_stock_drift_units_total',
  help: 'Units by which the fast store differed from the durable records at reconciliation (direction low|high)',
  labels: ['direction'],
});

export const flashPhantomStockCounter = MetricsRegistry.counter({
  name: 'flash_sale_phantom_stock_units_total',
  help: 'Surplus units clamped away from the fast store during a sale',
  labels: [],
});

export const flashOversellCounter = MetricsRegistry.counter({
  name: 'flash_sale_oversell_detected_total',
  help: 'Units sold beyond the sale size that verification found',
  labels: [],
});

export const flashClaimsExpiredCounter = MetricsRegistry.counter({
  name: 'flash_sale_claims_expired_total',
  help: 'Abandoned claims the sweeper gave back',
  labels: [],
});

export const flashReconcileWaitingGauge = MetricsRegistry.gauge({
  name: 'flash_sale_reconcile_waiting',
  help: 'Sales whose reconciliation waits for holds to resolve',
  labels: [],
});
