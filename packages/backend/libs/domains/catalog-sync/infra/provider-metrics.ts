import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/** Provider call instruments (FR-102). Labels are bounded: the provider and the HTTP status or failure kind. */
export const providerCallsCounter = MetricsRegistry.counter({
  name: 'catalog_sync_provider_calls_total',
  help: 'HTTP attempts to a provider by status (or failure kind when no answer came)',
  labels: ['provider', 'status'],
});

export const provider429Counter = MetricsRegistry.counter({
  name: 'catalog_sync_provider_429_total',
  help: 'Provider answers 429',
  labels: ['provider'],
});

export const breakerOpenedCounter = MetricsRegistry.counter({
  name: 'catalog_sync_breaker_opened_total',
  help: 'Times a provider circuit breaker opened or reopened',
  labels: ['provider'],
});
