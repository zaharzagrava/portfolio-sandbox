import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the tenancy domain. Counters carry a bounded reason label only: never a shop or user id (the
 * registry refuses those labels); those go to logs and traces (VIII.1, FR-080).
 */
export const crossTenantCounter = MetricsRegistry.counter({
  name: 'tenancy_cross_tenant_total',
  help: 'Transactions that bypassed row-level security, by allowlisted reason',
  labels: ['reason'],
});
export const authzDeniedCounter = MetricsRegistry.counter({
  name: 'tenancy_authz_denied_total',
  help: 'Shop-scoped requests refused by the guard, by reason',
  labels: ['reason'],
});
export const authzCacheCounter = MetricsRegistry.counter({
  name: 'tenancy_authz_cache_total',
  help: 'Authorization cache lookups by result (hit, miss, fallback, strong)',
  labels: ['result'],
});
export const serializationRetryCounter = MetricsRegistry.counter({
  name: 'tenancy_serialization_retries_total',
  help: 'Last-owner transactions that exhausted their serialization retries',
  labels: ['outcome'],
});
export const provisionedCounter = MetricsRegistry.counter({
  name: 'tenancy_provisioned_total',
  help: 'Membership and shop provisioning outcomes by reason',
  labels: ['outcome'],
});
