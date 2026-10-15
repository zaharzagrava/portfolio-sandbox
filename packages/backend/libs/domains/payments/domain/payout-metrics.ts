import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the payouts (S15 FR-052, contracts/events.md "Metrics"). Labels are closed enums only: never a
 * payout, shop or destination (the registry refuses id-like labels); ids go to logs and traces.
 */
export const payoutCreatedCounter = MetricsRegistry.counter({
  name: 'payout_created_total',
  help: 'Payouts created by the weekly run',
  labels: [],
});

export const payoutSkippedCounter = MetricsRegistry.counter({
  name: 'payout_skipped_total',
  help: 'Shops skipped by the weekly run, by reason',
  labels: ['reason'],
});

export const payoutTransferCounter = MetricsRegistry.counter({
  name: 'payout_transfer_total',
  help: 'Provider transfer outcomes (paid, rejected, transient, unknown)',
  labels: ['outcome'],
});

export const payoutInDoubtAgeGauge = MetricsRegistry.gauge({
  name: 'payout_in_doubt_age_seconds',
  help: 'Age of the oldest payout whose provider outcome is in doubt, 0 when none',
  labels: [],
});

export const payoutProviderMismatchCounter = MetricsRegistry.counter({
  name: 'payout_provider_mismatch_total',
  help: 'Provider answers that disagreed with the request, by kind',
  labels: ['kind'],
});

export const payoutConflictingOutcomeCounter = MetricsRegistry.counter({
  name: 'payout_conflicting_outcome_total',
  help: 'Late provider outcomes that contradict a final payout',
  labels: [],
});

export const payoutDiscrepancyCounter = MetricsRegistry.counter({
  name: 'payout_discrepancy_detected_total',
  help: 'Differences between a payout and the provider found by the audit, by kind',
  labels: ['kind'],
});

export const payoutRunDurationHistogram = MetricsRegistry.histogram({
  name: 'payout_run_duration_seconds',
  help: 'Duration of one execution of the weekly run',
  labels: [],
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
});

export const payoutRunCounter = MetricsRegistry.counter({
  name: 'payout_run_total',
  help: 'Weekly run executions by final status',
  labels: ['status'],
});
