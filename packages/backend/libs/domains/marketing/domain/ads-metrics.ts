import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of sponsored listings (S36 AS-76). Labels are bounded outcomes only: never a campaign, shop, token or
 * address value. `ads_reconciliation_drift_ratio{day}` carries a day (bounded: only the last 7 are kept, see
 * `ReconciliationService`).
 */
export const adsImpressionsCounter = MetricsRegistry.counter({
  name: 'ads_impressions_total',
  help: 'Sponsored slot requests by result (served, degraded)',
  labels: ['result'],
});

export const adsClicksCounter = MetricsRegistry.counter({
  name: 'ads_clicks_total',
  help: 'Click requests by outcome (counted, duplicate, invalid_token, expired, ip_burst, repeat_clicker, filter_unavailable, record_failed)',
  labels: ['outcome'],
});

export const adsLateClicksCounter = MetricsRegistry.counter({
  name: 'ads_late_clicks_total',
  help: 'Clicks aggregated more than 2 minutes after they were received',
  labels: [],
});

export const adsAggregatorBatchesCounter = MetricsRegistry.counter({
  name: 'ads_aggregator_batches_total',
  help: 'Aggregator batches by result (committed, failed)',
  labels: ['result'],
});

export const adsAggregatorFencedCounter = MetricsRegistry.counter({
  name: 'ads_aggregator_fenced_total',
  help: 'Times the aggregator was fenced by a newer instance with the same transactional id',
  labels: [],
});

export const adsBillingChargedCounter = MetricsRegistry.counter({
  name: 'ads_billing_charged_minor_total',
  help: 'Minor units charged to shops for ad clicks (hourly runs)',
  labels: [],
});

export const adsBillingAdjustmentCounter = MetricsRegistry.counter({
  name: 'ads_billing_adjustment_minor_total',
  help: 'Minor units moved by reconciliation adjustments, by direction (charge, refund)',
  labels: ['direction'],
});

export const adsBillingOrphanCounter = MetricsRegistry.counter({
  name: 'ads_billing_orphan_aggregate_total',
  help: 'Aggregates skipped because their campaign does not exist',
  labels: [],
});

export const adsBillingLagGauge = MetricsRegistry.gauge({
  name: 'ads_billing_lag_seconds',
  help: 'Seconds between the end of the last billed hour and now',
  labels: [],
});

export const adsReconciliationRunsCounter = MetricsRegistry.counter({
  name: 'ads_reconciliation_runs_total',
  help: 'Reconciliation runs by status (completed, failed)',
  labels: ['status'],
});

export const adsReconciliationDriftGauge = MetricsRegistry.gauge({
  name: 'ads_reconciliation_drift_ratio',
  help: 'Absolute difference between exact and billed clicks divided by exact clicks, by day',
  labels: ['day'],
});
