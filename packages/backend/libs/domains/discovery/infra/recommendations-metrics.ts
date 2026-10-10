import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/** Instruments of recommendations (S34 FR-028). Labels are fixed enums only: never a product, order or buyer id. */
export const recommendationsRequests = MetricsRegistry.counter({
  name: 'recommendations_requests_total',
  help: 'Recommendation requests by result (ok, empty, not_found, invalid, unavailable)',
  labels: ['result'],
});

export const recommendationsHops = MetricsRegistry.counter({
  name: 'recommendations_hops_total',
  help: 'Items served by hop count (1 direct, 2 expanded)',
  labels: ['hops'],
});

export const recommendationsBadEntries = MetricsRegistry.counter({
  name: 'recommendations_bad_entries_total',
  help: 'Stored neighbour entries skipped because they were damaged',
  labels: [],
});

export const recommendationsBasketSkipped = MetricsRegistry.counter({
  name: 'recommendations_basket_skipped_total',
  help: 'Paid orders that did not become a basket, by reason (too_small, too_large)',
  labels: ['reason'],
});

export const recommendationsBaskets = MetricsRegistry.counter({
  name: 'recommendations_baskets_total',
  help: 'Baskets by capture outcome (stored, duplicate, stale)',
  labels: ['outcome'],
});

export const recommendationsBuildDuration = MetricsRegistry.histogram({
  name: 'recommendations_build_duration_seconds',
  help: 'Seconds one completed nightly build took',
  labels: [],
  buckets: [1, 10, 60, 300, 900, 1800, 3600],
});

export const recommendationsBuildProducts = MetricsRegistry.gauge({
  name: 'recommendations_build_products',
  help: 'Products with a published list in the last completed build',
  labels: [],
});

export const recommendationsBuildEdges = MetricsRegistry.gauge({
  name: 'recommendations_build_edges',
  help: 'Edges published by the last completed build',
  labels: [],
});

export const recommendationsBuildLastSuccess = MetricsRegistry.gauge({
  name: 'recommendations_build_last_success_timestamp',
  help: 'Epoch seconds of the last completed build; the 36-hour alert reads it',
  labels: [],
});

export const recommendationsBuildSkipped = MetricsRegistry.counter({
  name: 'recommendations_build_skipped_total',
  help: 'Builds that did nothing, by reason (empty, locked)',
  labels: ['reason'],
});
