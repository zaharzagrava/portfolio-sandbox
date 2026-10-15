import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/** Instruments of the capability (FR-102). Labels are bounded enums only; ids go to logs. */
export const syncItemsCounter = MetricsRegistry.counter({
  name: 'catalog_sync_items_total',
  help: 'Provider items by result (quarantined)',
  labels: ['provider', 'result'],
});

export const syncRunsCounter = MetricsRegistry.counter({
  name: 'catalog_sync_runs_total',
  help: 'Finished sync runs by provider, kind and outcome',
  labels: ['provider', 'kind', 'outcome'],
});

export const reconcileFindingsCounter = MetricsRegistry.counter({
  name: 'catalog_sync_reconcile_findings_total',
  help: 'Reconciliation findings by kind',
  labels: ['kind'],
});

export const syncLagGauge = MetricsRegistry.gauge({
  name: 'catalog_sync_lag_seconds',
  help: 'Largest age of the product watermark among the ACTIVE integrations of a provider, at the last evaluation',
  labels: ['provider'],
});

export const echoSuppressedCounter = MetricsRegistry.counter({
  name: 'catalog_sync_echo_suppressed_total',
  help: 'Local stock events dropped because they were the echo of the capability own apply',
  labels: [],
});

export const webhooksCounter = MetricsRegistry.counter({
  name: 'catalog_sync_webhooks_total',
  help: 'Webhook deliveries by provider and result (accepted, duplicate, ignored, invalid_signature, stale, too_large)',
  labels: ['provider', 'result'],
});

export const quarantineOpenGauge = MetricsRegistry.gauge({
  name: 'catalog_sync_quarantine_open',
  help: 'Open quarantine rows over all integrations, at the last evaluation',
  labels: [],
});

export const conflictsOpenGauge = MetricsRegistry.gauge({
  name: 'catalog_sync_conflicts_open',
  help: 'Open stock conflicts over all integrations, at the last evaluation',
  labels: [],
});

export const breakerOpenGauge = MetricsRegistry.gauge({
  name: 'catalog_sync_breaker_open',
  help: 'Integrations whose circuit breaker is open, by provider, at the last evaluation',
  labels: ['provider'],
});
