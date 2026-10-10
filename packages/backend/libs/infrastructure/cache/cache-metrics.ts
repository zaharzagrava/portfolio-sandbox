import {
  CounterHandle,
  GaugeHandle,
  HistogramHandle,
  MetricsRegistry,
} from '@app/common/telemetry/metrics-registry';

/**
 * Outcomes of `cache_requests_total` (AS-71). The only label besides `outcome` is `namespace`, the first segment of
 * a key, so cardinality is bounded by code, never by data.
 */
export type CacheOutcome =
  | 'l1'
  | 'l2'
  | 'miss'
  | 'negative'
  | 'stale'
  | 'stale_error'
  | 'degraded'
  | 'corrupt'
  | 'oversize'
  | 'refused_below_minimum'
  | 'refused_unversioned'
  | 'refresh_failed';

export interface CacheMetrics {
  requests: CounterHandle;
  loaderCalls: CounterHandle;
  loaderDuration: HistogramHandle;
  invalidations: CounterHandle;
  breakerState: GaugeHandle;
  l1Entries: GaugeHandle;
  counterPending: GaugeHandle;
  lockAcquisitions: CounterHandle;
  counterOverflow: CounterHandle;
  bloomDegraded: CounterHandle;
  etagInvalid: CounterHandle;
}

let cached: CacheMetrics | undefined;

/** Registers (once per process) the toolkit's instruments in the platform registry. */
export function cacheMetrics(): CacheMetrics {
  if (cached) return cached;
  cached = {
    requests: MetricsRegistry.counter({
      name: 'cache_requests_total',
      help: 'Cache reads by namespace and outcome',
      labels: ['namespace', 'outcome'],
    }),
    loaderCalls: MetricsRegistry.counter({
      name: 'cache_loader_calls_total',
      help: 'Loader invocations by namespace',
      labels: ['namespace'],
    }),
    loaderDuration: MetricsRegistry.histogram({
      name: 'cache_loader_duration_seconds',
      help: 'Loader duration by namespace',
      labels: ['namespace'],
      buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    }),
    invalidations: MetricsRegistry.counter({
      name: 'cache_invalidations_total',
      help: 'Invalidations by result (ok, failed, applied, skipped)',
      labels: ['result'],
    }),
    breakerState: MetricsRegistry.gauge({
      name: 'cache_breaker_state',
      help: 'Store circuit breaker: 0 closed, 1 open, 2 half-open',
      labels: [],
    }),
    l1Entries: MetricsRegistry.gauge({
      name: 'cache_l1_entries',
      help: 'Entries in the in-process L1',
      labels: [],
    }),
    counterPending: MetricsRegistry.gauge({
      name: 'cache_counter_pending_members',
      help: 'Pending members of a write-behind counter',
      labels: ['counter'],
    }),
    lockAcquisitions: MetricsRegistry.counter({
      name: 'cache_lock_acquisitions_total',
      help: 'Distributed lock acquisitions by outcome',
      labels: ['outcome'],
    }),
    counterOverflow: MetricsRegistry.counter({
      name: 'cache_counter_overflow_total',
      help: 'Write-behind increments refused at the pending-member cap',
      labels: ['counter'],
    }),
    bloomDegraded: MetricsRegistry.counter({
      name: 'cache_bloom_degraded_total',
      help: 'Bloom filter checks answered true because the store was unavailable',
      labels: [],
    }),
    etagInvalid: MetricsRegistry.counter({
      name: 'cache_etag_invalid_total',
      help: 'Caller-supplied entity tags that were not emitted',
      labels: [],
    }),
  };
  return cached;
}
