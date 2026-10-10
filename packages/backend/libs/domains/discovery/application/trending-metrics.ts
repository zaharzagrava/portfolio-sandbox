import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/** Instruments of trending (S35 FR-025, R-17). Labels are fixed enums only: never a product, category, visitor or order id. */
export const trendingEvents = MetricsRegistry.counter({
  name: 'trending_events_total',
  help: 'Analytics events by outcome (counted, ignored, duplicate, invalid, late_corrected, late_dropped, visitor_capped, category_capped, category_rejected)',
  labels: ['outcome'],
});

export const trendingWindowsClosed = MetricsRegistry.counter({
  name: 'trending_windows_closed_total',
  help: 'Windows closed by the watermark or the idle clock',
  labels: [],
});

export const trendingMerges = MetricsRegistry.counter({
  name: 'trending_merges_total',
  help: 'Window merges by outcome (merged, merge_replayed, merge_failed)',
  labels: ['outcome'],
});

export const trendingLastMerge = MetricsRegistry.gauge({
  name: 'trending_last_merge_timestamp_seconds',
  help: 'Epoch seconds of the last successful merge; the 10-minute alert reads it',
  labels: [],
});

export const trendingOldestUnmergedAge = MetricsRegistry.gauge({
  name: 'trending_oldest_unmerged_window_age_seconds',
  help: 'Age of the oldest window that is open or closed but not merged',
  labels: [],
});

export const trendingConsumerLag = MetricsRegistry.gauge({
  name: 'trending_consumer_lag',
  help: 'Messages between the end of the owned partitions and the last consumed offset',
  labels: [],
});

export const trendingTrackedBytes = MetricsRegistry.gauge({
  name: 'trending_tracked_bytes',
  help: 'Memory held by open-window sketches and filters',
  labels: [],
});

export const trendingRequests = MetricsRegistry.counter({
  name: 'trending_requests_total',
  help: 'Serving requests by outcome (ok, empty, invalid, rate_limited, unavailable)',
  labels: ['outcome'],
});

export const trendingDependencyFailures = MetricsRegistry.counter({
  name: 'trending_dependency_failures_total',
  help: 'Serving dependency failures (aggregate, product, shop, cache)',
  labels: ['dependency'],
});

export const trendingRankingCache = MetricsRegistry.counter({
  name: 'trending_ranking_cache_total',
  help: 'Ranking cache lookups by result (hit, miss)',
  labels: ['result'],
});

export const trendingConnectFailures = MetricsRegistry.counter({
  name: 'trending_consumer_connect_failures_total',
  help: 'Failed connect or subscribe attempts of the consumer',
  labels: [],
});
