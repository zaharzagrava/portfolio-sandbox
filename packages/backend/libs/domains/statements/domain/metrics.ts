import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the statements (S16 FR-054). Labels are closed enums only: never a shop, order or month (the
 * registry refuses id-like labels); ids go to logs and traces.
 */
export const rateChangesCounter = MetricsRegistry.counter({
  name: 'statements_rate_changes_total',
  help: 'Commission rate change requests by outcome (recorded, noop, refused)',
  labels: ['outcome'],
});

export const periodCloseCounter = MetricsRegistry.counter({
  name: 'statements_period_close_total',
  help: 'Period close runs by final status (completed, failed, interrupted, not_ready)',
  labels: ['status'],
});

export const periodCloseDuration = MetricsRegistry.histogram({
  name: 'statements_period_close_duration_seconds',
  help: 'Duration of one close run',
  labels: [],
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
});

export const adjustmentsBookedCounter = MetricsRegistry.counter({
  name: 'statements_adjustments_booked_total',
  help: 'Adjustments booked, by cause kind',
  labels: ['cause'],
});

export const eventsAppliedCounter = MetricsRegistry.counter({
  name: 'statements_events_applied_total',
  help: 'Fact events by stream and outcome (applied, duplicate, stale)',
  labels: ['stream', 'outcome'],
});

export const eventsRejectedCounter = MetricsRegistry.counter({
  name: 'statements_events_rejected_total',
  help: 'Fact events dead-lettered, by stream and reason',
  labels: ['stream', 'reason'],
});

export const ingestionLagGauge = MetricsRegistry.gauge({
  name: 'statements_ingestion_lag_seconds',
  help: 'Seconds between now and the watermark of a fact stream',
  labels: ['stream'],
});

export const exportActiveGauge = MetricsRegistry.gauge({
  name: 'statements_export_active',
  help: 'CSV exports streaming now',
  labels: [],
});

export const exportAbortedCounter = MetricsRegistry.counter({
  name: 'statements_export_aborted_total',
  help: 'CSV exports aborted after the first byte, by reason (db_error, timeout, shutdown)',
  labels: ['reason'],
});

export const findingsCounter = MetricsRegistry.counter({
  name: 'statements_reconciliation_findings_total',
  help: 'Reconciliation findings opened, by kind',
  labels: ['kind'],
});

export const completenessViolationsCounter = MetricsRegistry.counter({
  name: 'statements_completeness_violations_total',
  help: 'Closed months whose snapshot plus adjustments differ from a recomputation',
  labels: [],
});

export const replicaFallbackCounter = MetricsRegistry.counter({
  name: 'statements_replica_fallback_total',
  help: 'Reads that fell back from the replica to the primary',
  labels: [],
});

export const unpricedLinesCounter = MetricsRegistry.counter({
  name: 'statements_unpriced_lines_total',
  help: 'Sale lines that no rate resolved, found by a close',
  labels: [],
});
