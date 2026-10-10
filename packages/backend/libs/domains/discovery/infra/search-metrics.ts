import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of search (S32 FR-059). Labels are bounded outcomes only: never a query, product, shop or user.
 */
export const searchRequestsCounter = MetricsRegistry.counter({
  name: 'search_requests_total',
  help: 'Public searches by mode (browse, lexical, semantic) and status (ok, invalid, unavailable)',
  labels: ['mode', 'status'],
});

export const searchDuration = MetricsRegistry.histogram({
  name: 'search_duration_seconds',
  help: 'Seconds spent answering a search',
  labels: [],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
});

export const searchDegradedCounter = MetricsRegistry.counter({
  name: 'search_degraded_total',
  help: 'Searches answered in a degraded way, by reason (semantic_unavailable)',
  labels: ['reason'],
});

export const searchUnavailableCounter = MetricsRegistry.counter({
  name: 'search_unavailable_total',
  help: 'Searches refused because the engine did not answer within the budget',
  labels: [],
});

export const searchProjectionLag = MetricsRegistry.histogram({
  name: 'search_projection_lag_seconds',
  help: 'Seconds from the event time to its projection into the index, by source',
  labels: ['source'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
});

export const searchStaleIgnoredCounter = MetricsRegistry.counter({
  name: 'search_stale_events_ignored_total',
  help: 'Events ignored because a newer version was already projected, by source',
  labels: ['source'],
});

export const searchIgnoredCounter = MetricsRegistry.counter({
  name: 'search_ignored_total',
  help: 'Events acknowledged without effect, by reason (sandbox, unknown_type, shop_deleted)',
  labels: ['reason'],
});

export const searchReindexDuration = MetricsRegistry.histogram({
  name: 'search_reindex_duration_seconds',
  help: 'Seconds from the start of a reindex run to its end',
  labels: ['kind'],
  buckets: [1, 5, 30, 120, 600, 1800, 3600, 7200, 21600],
});

export const searchReindexFailedCounter = MetricsRegistry.counter({
  name: 'search_reindex_failed_total',
  help: 'Reindex runs that ended FAILED, by reason',
  labels: ['reason'],
});

export const searchEventsDroppedCounter = MetricsRegistry.counter({
  name: 'search_events_dropped_total',
  help: 'search.performed and search.result_clicked events that could not be published',
  labels: ['type'],
});
