import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the pickup capability (S19 FR-052, AS-45). Labels are fixed enums only: never a shop, point,
 * product, coordinate, address or request id.
 */
export const PickupMetrics = {
  searchDuration: MetricsRegistry.histogram({
    name: 'pickup_search_duration_seconds',
    help: 'Shopper reads by endpoint (search, browse, clusters) and outcome (ok, invalid, unavailable)',
    labels: ['endpoint', 'outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.08, 0.15, 0.4, 0.8, 2],
  }),
  rejections: MetricsRegistry.counter({
    name: 'pickup_http_rejections_total',
    help: 'Shopper reads refused with 429 or 503 by endpoint and code',
    labels: ['endpoint', 'code'],
  }),
  indexLag: MetricsRegistry.gauge({
    name: 'pickup_index_lag_seconds',
    help: 'Seconds between the commit of the newest applied event and now',
    labels: [],
  }),
  stockChanges: MetricsRegistry.counter({
    name: 'pickup_stock_changes_total',
    help: 'Stock writes by kind (set, adjust, rejected)',
    labels: ['kind'],
  }),
  indexWriteFailures: MetricsRegistry.counter({
    name: 'pickup_index_write_failures_total',
    help: 'Bulk writes to the availability index that failed',
    labels: [],
  }),
};

/**
 * Consumer lag and dead letters are the consumer framework's series (`consumer_lag`, `dlq_total{consumer}`), labelled
 * with the four `pickup-index-*` group names; the limiter's own `rate_limit_*` series count its outage fallbacks.
 */
