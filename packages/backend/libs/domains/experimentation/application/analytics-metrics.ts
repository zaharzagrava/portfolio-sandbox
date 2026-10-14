import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Metrics of analytics and experiments (S39 AS-54, FR-051). Every label has a closed value list (the per-event codes,
 * statuses, sources, operations): an event's content, a user id or an experiment key never becomes a series.
 */
export const analyticsEventsTotal = MetricsRegistry.counter({
  name: 'analytics_events_total',
  help: 'Client events judged by the fallback collector, by outcome (accepted, rejected, duplicate_in_batch) and reason',
  labels: ['outcome', 'reason'],
});
export const analyticsIngestRequestsTotal = MetricsRegistry.counter({
  name: 'analytics_ingest_requests_total',
  help: 'Ingest requests by HTTP status',
  labels: ['status'],
});
export const analyticsProduceFailuresTotal = MetricsRegistry.counter({
  name: 'analytics_produce_failures_total',
  help: 'Ingest requests failed because the stream did not acknowledge in time',
  labels: [],
});
export const analyticsRateLimitedTotal = MetricsRegistry.counter({
  name: 'analytics_rate_limited_total',
  help: 'Ingest requests refused by the rate limit',
  labels: [],
});
export const analyticsRateLimiterDegradedTotal = MetricsRegistry.counter({
  name: 'analytics_rate_limiter_degraded_total',
  help: 'Ingest requests admitted because the rate limiter store was unavailable',
  labels: [],
});
export const analyticsDeadLetterTotal = MetricsRegistry.counter({
  name: 'analytics_dead_letter_total',
  help: 'Messages that could not be stored, by source (store, purchase-projector)',
  labels: ['source'],
});
export const experimentAssignmentsTotal = MetricsRegistry.counter({
  name: 'experiment_assignments_total',
  help: 'Assignment requests by outcome (assigned, none, degraded)',
  labels: ['outcome'],
});
export const experimentResultsTotal = MetricsRegistry.counter({
  name: 'experiment_results_total',
  help: 'Results readouts by trust verdict',
  labels: ['trustworthy'],
});
export const experimentSrmMismatchTotal = MetricsRegistry.counter({
  name: 'experiment_srm_mismatch_total',
  help: 'Results readouts that found a sample ratio mismatch',
  labels: [],
});
export const analyticsStoreErrorsTotal = MetricsRegistry.counter({
  name: 'analytics_store_errors_total',
  help: 'Analytical store failures by operation',
  labels: ['operation'],
});
