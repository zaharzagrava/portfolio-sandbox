import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of `payments` (S13 A22, AS-62). Labels are bounded outcomes only: never a user, order or payment id
 * (the registry refuses those labels); ids go to logs and traces.
 */
export const paymentsCreatedCounter = MetricsRegistry.counter({
  name: 'payments_created_total',
  help: 'Payment intents accepted or refused by result',
  labels: ['result'],
});

export const paymentTransitionsCounter = MetricsRegistry.counter({
  name: 'payments_status_transitions_total',
  help: 'Payment status moves by from and to status',
  labels: ['from', 'to'],
});

export const providerCallsCounter = MetricsRegistry.counter({
  name: 'payments_provider_calls_total',
  help: 'Provider calls by operation and outcome (succeeded, declined, rejected, not_sent, ambiguous, invalid)',
  labels: ['operation', 'outcome'],
});

export const unknownOutcomesCounter = MetricsRegistry.counter({
  name: 'payments_unknown_outcomes_total',
  help: 'Charges that ended with an unknown outcome',
  labels: [],
});

export const unknownOldestAgeGauge = MetricsRegistry.gauge({
  name: 'payments_unknown_oldest_age_seconds',
  help: 'Age of the oldest payment still UNKNOWN',
  labels: [],
});

export const breakerOpenGauge = MetricsRegistry.gauge({
  name: 'circuit_breaker_open',
  help: 'Provider circuit breaker: 1 while open, 0 otherwise',
  labels: ['breaker'],
});

export const refundPendingOldestAgeGauge = MetricsRegistry.gauge({
  name: 'payments_refund_pending_oldest_age_seconds',
  help: 'Age of the oldest payment waiting for its refund',
  labels: [],
});

export const consumerDeadLetteredCounter = MetricsRegistry.counter({
  name: 'payments_consumer_dead_lettered_total',
  help: 'Messages the payments consumers refused for good, by reason',
  labels: ['reason'],
});

export const providerMismatchCounter = MetricsRegistry.counter({
  name: 'payments_provider_mismatch_total',
  help: 'Provider answers whose field did not match our record, by field',
  labels: ['field'],
});

export const conflictingProviderStateCounter = MetricsRegistry.counter({
  name: 'payments_conflicting_provider_state_total',
  help: 'Provider says something that contradicts a final payment status',
  labels: [],
});

export const completedForUnpayableOrderCounter = MetricsRegistry.counter({
  name: 'payments_completed_for_unpayable_order_total',
  help: 'Payments that completed although their order was already cancelled',
  labels: [],
});

export const refundStuckCounter = MetricsRegistry.counter({
  name: 'payments_refund_stuck_total',
  help: 'Refunds that the provider refused or that exceeded the 24-hour window',
  labels: [],
});

export const refundRequestsCounter = MetricsRegistry.counter({
  name: 'payments_refund_requests_total',
  help: 'Refund requests by result',
  labels: ['result'],
});

export const realtimeFailedCounter = MetricsRegistry.counter({
  name: 'payments_realtime_publish_failed_total',
  help: 'Realtime pushes that failed (best effort)',
  labels: [],
});
