import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the catalog (AS-85). Labels are bounded outcomes only: never a product, shop or user id (the registry
 * refuses those labels); the ids go to logs and traces.
 */
export const productReadCounter = MetricsRegistry.counter({
  name: 'catalog_product_read_total',
  help: 'Public product reads by outcome (hit, miss, stale, negative, hidden, degraded, not_modified)',
  labels: ['outcome'],
});

export const productInvalidationCounter = MetricsRegistry.counter({
  name: 'catalog_product_invalidation_total',
  help: 'Cache invalidations by result (applied, skipped, failed, coalesced)',
  labels: ['result'],
});

export const productInvalidationLag = MetricsRegistry.histogram({
  name: 'catalog_product_invalidation_lag_seconds',
  help: 'Seconds from the product event to the cache invalidation',
  labels: [],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
});

export const viewFlushCounter = MetricsRegistry.counter({
  name: 'catalog_view_flush_total',
  help: 'View-count flushes by result (applied, failed, skipped, poison)',
  labels: ['result'],
});

export const viewFlushPending = MetricsRegistry.gauge({
  name: 'catalog_view_flush_pending',
  help: 'Products with a view delta waiting for the next flush',
  labels: [],
});

export const stockOperationCounter = MetricsRegistry.counter({
  name: 'catalog_stock_operation_total',
  help: 'Stock operations by result (applied, replayed, rejected, conflict)',
  labels: ['result'],
});

export const backfillOrphansGauge = MetricsRegistry.gauge({
  name: 'catalog_backfill_orphans',
  help: 'Products still without a shop id',
  labels: [],
});

export const shopSweepCounter = MetricsRegistry.counter({
  name: 'catalog_shop_sweep_total',
  help: 'Batches of the shop sweep and purge jobs by kind (drop_entries, purge)',
  labels: ['kind'],
});

export const productWriteCounter = MetricsRegistry.counter({
  name: 'catalog_product_write_total',
  help: 'Product writes by operation and result',
  labels: ['operation', 'result'],
});
