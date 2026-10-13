import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the ledger and the reconciliation (S14 AS-65, contracts/services.md "Metrics"). Labels are bounded
 * outcomes only: never an account, shop, journal or run id (the registry refuses those); ids go to logs and traces.
 */
export const journalsPostedCounter = MetricsRegistry.counter({
  name: 'ledger_journals_posted_total',
  help: 'Journals posted by kind',
  labels: ['kind'],
});

export const postRejectedCounter = MetricsRegistry.counter({
  name: 'ledger_post_rejected_total',
  help: 'Postings refused, by reason',
  labels: ['reason'],
});

export const lockWaitHistogram = MetricsRegistry.histogram({
  name: 'ledger_lock_wait_seconds',
  help: 'Time spent taking the balance rows of a posting, by account class',
  labels: ['accountClass'],
  buckets: [0.001, 0.005, 0.02, 0.1, 0.5, 1, 2, 5],
});

export const projectionLagGauge = MetricsRegistry.gauge({
  name: 'ledger_balance_projection_lag_seconds',
  help: 'Seconds between the posting time of the last applied event and now',
  labels: [],
});

export const projectionStaleCounter = MetricsRegistry.counter({
  name: 'ledger_projection_stale_total',
  help: 'Balance lines ignored because a newer version was already stored',
  labels: [],
});

export const projectionLegacySkippedCounter = MetricsRegistry.counter({
  name: 'ledger_projection_legacy_skipped_total',
  help: 'Version 1 journal events skipped by the balance projector',
  labels: [],
});

export const settlementDeferredCounter = MetricsRegistry.counter({
  name: 'ledger_settlement_deferred_total',
  help: 'Settlements deferred because the sale was not recorded yet',
  labels: [],
});

export const settlementSkippedCounter = MetricsRegistry.counter({
  name: 'ledger_settlement_skipped_total',
  help: 'Settlements not posted, by reason (refunded)',
  labels: ['reason'],
});

export const settlementDeadLetteredCounter = MetricsRegistry.counter({
  name: 'ledger_settlement_dead_lettered_total',
  help: 'Settlements given up after the last deferral, by reason',
  labels: ['reason'],
});

export const consumerDeadLetteredCounter = MetricsRegistry.counter({
  name: 'ledger_consumer_dead_lettered_total',
  help: 'Messages the ledger consumers dead-lettered, by reason',
  labels: ['reason'],
});

export const invariantViolationsCounter = MetricsRegistry.counter({
  name: 'ledger_invariant_violations_total',
  help: 'Violations found by the invariant checker, by check',
  labels: ['check'],
});

export const defaultPartitionRowsGauge = MetricsRegistry.gauge({
  name: 'ledger_default_partition_rows',
  help: 'Entries sitting in the catch-all partition',
  labels: [],
});

export const reconciliationRunsCounter = MetricsRegistry.counter({
  name: 'reconciliation_runs_total',
  help: 'Reconciliation runs by final status',
  labels: ['status'],
});

export const reconciliationIssuesOpenGauge = MetricsRegistry.gauge({
  name: 'reconciliation_issues_open',
  help: 'Open reconciliation issues by kind',
  labels: ['kind'],
});

export const reconciliationLinesSkippedCounter = MetricsRegistry.counter({
  name: 'reconciliation_lines_skipped_total',
  help: 'Statement lines skipped, by type',
  labels: ['type'],
});

export const reconciliationOldestOpenIssueGauge = MetricsRegistry.gauge({
  name: 'reconciliation_oldest_open_issue_age_seconds',
  help: 'Age of the oldest open reconciliation issue',
  labels: [],
});
