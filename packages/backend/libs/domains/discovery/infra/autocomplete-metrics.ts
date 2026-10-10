import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/** Instruments of autocomplete (S33 FR-038). Labels are bounded enums only: never a query, prefix or user. */
export const autocompleteRequests = MetricsRegistry.counter({
  name: 'autocomplete_requests_total',
  help: 'Suggest requests by status (ok, degraded, invalid)',
  labels: ['status'],
});

export const autocompleteDegraded = MetricsRegistry.counter({
  name: 'autocomplete_degraded_total',
  help: 'Suggest answers that lacked a source, by degraded reason',
  labels: ['reason'],
});

export const autocompleteSourceDuration = MetricsRegistry.histogram({
  name: 'autocomplete_source_duration_seconds',
  help: 'Seconds spent in one source (query, catalog, typo)',
  labels: ['source'],
  buckets: [0.001, 0.005, 0.01, 0.02, 0.04, 0.08, 0.25],
});

export const autocompleteCircuitState = MetricsRegistry.gauge({
  name: 'autocomplete_circuit_state',
  help: 'Catalog circuit: 0 closed, 1 half open, 2 open',
  labels: [],
});

export const autocompleteBuilds = MetricsRegistry.counter({
  name: 'autocomplete_builds_total',
  help: 'Snapshot builds by outcome (published, unchanged, skipped_empty, superseded, failed)',
  labels: ['outcome'],
});

export const autocompleteSnapshotAge = MetricsRegistry.gauge({
  name: 'autocomplete_snapshot_age_seconds',
  help: 'Age of the snapshot a node serves, at the last poll',
  labels: [],
});

export const autocompleteSnapshotVersion = MetricsRegistry.gauge({
  name: 'autocomplete_snapshot_version',
  help: 'Creation time (epoch seconds) of the snapshot a node serves; 0 when none',
  labels: [],
});

export const autocompleteSnapshotLoadFailures = MetricsRegistry.counter({
  name: 'autocomplete_snapshot_load_failures_total',
  help: 'Snapshot loads that failed, by reason (missing, checksum, corrupt, format, invalid_entry, pointer_unreachable)',
  labels: ['reason'],
});
