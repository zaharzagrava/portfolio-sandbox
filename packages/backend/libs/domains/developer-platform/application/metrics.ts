import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/** Closed label sets, no key, shop or client identifiers (contracts/events.md, metrics). */
export const apiMetrics = {
  authFailures: () =>
    MetricsRegistry.counter({
      name: 'public_api_auth_failures_total',
      help: 'Failed public API authentications by reason',
      labels: ['reason'],
    }),
  keyCacheDegraded: () =>
    MetricsRegistry.counter({
      name: 'public_api_key_cache_degraded_total',
      help: 'Key verifications served from the system of record because the fast store failed',
      labels: [],
    }),
  authUnavailable: () =>
    MetricsRegistry.counter({
      name: 'public_api_auth_unavailable_total',
      help: 'Authentications answered 503 because neither the fast store nor the system of record could verify the key',
      labels: [],
    }),
  deprecatedCalls: () =>
    MetricsRegistry.counter({
      name: 'public_api_deprecated_calls_total',
      help: 'Calls to a deprecated route or version',
      labels: ['route', 'version'],
    }),
  rateLimitDegraded: () =>
    MetricsRegistry.counter({
      name: 'public_api_ratelimit_degraded_total',
      help: 'Calls served without a rate-limit answer because the limiter store was unreachable',
      labels: [],
    }),
  quotaDegraded: () =>
    MetricsRegistry.counter({
      name: 'public_api_quota_degraded_total',
      help: 'Calls admitted without a quota answer',
      labels: ['reason'],
    }),
  batchDeadlineExceeded: () =>
    MetricsRegistry.counter({
      name: 'public_api_batch_deadline_exceeded_total',
      help: 'Batch operations not started within the 10 s budget',
      labels: [],
    }),
  bulkChunkReplayed: () =>
    MetricsRegistry.counter({
      name: 'public_api_bulk_chunk_replayed_total',
      help: 'Bulk stock chunks delivered again after completion',
      labels: [],
    }),
};
