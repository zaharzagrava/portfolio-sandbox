/**
 * The instruments of FR-102 in one place. They are created next to the code that moves them (`application/sync-metrics`,
 * `infra/provider-metrics`); this file is the list the specs and the dashboards check against. No label carries a
 * token, secret, signature, payload or identifier: providers, kinds, outcomes and results are closed sets.
 */
export {
  breakerOpenGauge,
  conflictsOpenGauge,
  echoSuppressedCounter,
  quarantineOpenGauge,
  reconcileFindingsCounter,
  syncItemsCounter,
  syncLagGauge,
  syncRunsCounter,
  webhooksCounter,
} from '../application/sync-metrics';
export {
  breakerOpenedCounter,
  provider429Counter,
  providerCallsCounter,
} from './provider-metrics';

export const FR102_METRIC_NAMES = [
  'catalog_sync_runs_total',
  'catalog_sync_lag_seconds',
  'catalog_sync_items_total',
  'catalog_sync_provider_calls_total',
  'catalog_sync_provider_429_total',
  'catalog_sync_echo_suppressed_total',
  'catalog_sync_quarantine_open',
  'catalog_sync_conflicts_open',
  'catalog_sync_webhooks_total',
  'catalog_sync_breaker_open',
  'catalog_sync_reconcile_findings_total',
] as const;
