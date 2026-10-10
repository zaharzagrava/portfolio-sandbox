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
