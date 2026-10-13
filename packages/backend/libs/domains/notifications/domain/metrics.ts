import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of notifications (specs/domains/S28-notifications/contracts/services.md "Metrics", AS-86). Names are
 * fixed by the contract. Labels are bounded outcomes (type, channel, line, status, provider, reason): never a user,
 * address, delivery or event id; those go to logs and traces.
 */
export const eventsConsumedCounter = MetricsRegistry.counter({
  name: 'notifications_events_consumed_total',
  help: 'Source events consumed, by type and outcome (mapped, ignored, dead_lettered)',
  labels: ['type', 'outcome'],
});

export const eventsIgnoredCounter = MetricsRegistry.counter({
  name: 'notifications_events_ignored_total',
  help: 'Valid events that produced nothing, by reason',
  labels: ['reason'],
});

export const deadLetterCounter = MetricsRegistry.counter({
  name: 'notifications_dead_letter_total',
  help: 'Messages moved to a dead-letter queue, by source and reason',
  labels: ['source', 'reason'],
});

export const inboxCreatedCounter = MetricsRegistry.counter({
  name: 'notifications_inbox_created_total',
  help: 'Inbox items created, by category',
  labels: ['category'],
});

export const deliveryCounter = MetricsRegistry.counter({
  name: 'notifications_delivery_total',
  help: 'Delivery status moves, by channel, line and status',
  labels: ['channel', 'line', 'status'],
});

export const deliveryAttemptCounter = MetricsRegistry.counter({
  name: 'notifications_delivery_attempt_total',
  help: 'Provider calls, by channel and outcome',
  labels: ['channel', 'outcome'],
});

export const failoverCounter = MetricsRegistry.counter({
  name: 'notifications_failover_total',
  help: 'Sends that moved to the next provider of the chain',
  labels: ['channel'],
});

/** 0 closed, 1 half-open, 2 open. */
export const providerCircuitGauge = MetricsRegistry.gauge({
  name: 'notifications_provider_circuit_state',
  help: 'Circuit breaker state per provider (0 closed, 1 half-open, 2 open)',
  labels: ['provider'],
});

export const limiterUnavailableCounter = MetricsRegistry.counter({
  name: 'notifications_limiter_unavailable_total',
  help: 'Send-budget decisions made without the rate-limit store, by priority',
  labels: ['priority'],
});

export const cappedCounter = MetricsRegistry.counter({
  name: 'notifications_capped_total',
  help: 'Marketing deliveries refused by the frequency cap',
  labels: ['channel'],
});

export const quietDelayedCounter = MetricsRegistry.counter({
  name: 'notifications_quiet_delayed_total',
  help: 'Deliveries held for quiet hours',
  labels: ['channel'],
});

export const expiredCounter = MetricsRegistry.counter({
  name: 'notifications_expired_total',
  help: 'Deliveries not sent because the event was too old',
  labels: ['type'],
});

export const staleVersionDroppedCounter = MetricsRegistry.counter({
  name: 'notifications_stale_version_dropped_total',
  help: 'Events dropped by the version guard',
  labels: ['family'],
});

export const realtimePublishFailedCounter = MetricsRegistry.counter({
  name: 'notifications_realtime_publish_failed_total',
  help: 'Realtime announcements that failed (routing continues)',
  labels: [],
});

export const unreadRebuiltCounter = MetricsRegistry.counter({
  name: 'notifications_unread_rebuilt_total',
  help: 'Unread counters rebuilt from the inbox',
  labels: [],
});

export const callbacksCounter = MetricsRegistry.counter({
  name: 'notifications_callbacks_total',
  help: 'Provider callbacks, by provider and outcome',
  labels: ['provider', 'outcome'],
});

export const callbacksDroppedCounter = MetricsRegistry.counter({
  name: 'notifications_callbacks_dropped_total',
  help: 'Provider callbacks given up on, by reason (unknown_message: no delivery matched within 10 minutes)',
  labels: ['reason'],
});

export const suppressedCounter = MetricsRegistry.counter({
  name: 'notifications_suppressed_total',
  help: 'Addresses suppressed, by channel and reason',
  labels: ['channel', 'reason'],
});

export const timezoneFallbackCounter = MetricsRegistry.counter({
  name: 'notifications_timezone_fallback_total',
  help: 'Stored time zones unknown to the runtime, replaced by UTC',
  labels: [],
});

export const deliveryLatencyHistogram = MetricsRegistry.histogram({
  name: 'notifications_delivery_latency_seconds',
  help: 'Time from routing to the provider accepting the message',
  labels: ['channel', 'line'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15, 60, 300],
});
