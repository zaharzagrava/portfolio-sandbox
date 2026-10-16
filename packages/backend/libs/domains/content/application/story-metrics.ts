import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * The series of S27 AS-96 through the S54 registry (names and bounded labels are checked at registration). No shop,
 * story, token or path is ever a label; those belong in logs and traces.
 */
export const storyMetrics = {
  publish: MetricsRegistry.counter({
    name: 'story_publish_total',
    help: 'Publish calls by result (published, refused, conflict, failed)',
    labels: ['result'],
  }),
  scheduleFired: MetricsRegistry.counter({
    name: 'story_schedule_fired_total',
    help: 'Scheduled publishes by result (published, skipped, failed, retried)',
    labels: ['result'],
  }),
  cachePurge: MetricsRegistry.counter({
    name: 'story_cache_purge_total',
    help: 'Invalidation attempts by target (origin, cdn, revalidate) and result (ok, retry, failed, permanent)',
    labels: ['target', 'result'],
  }),
  cachePurgeLag: MetricsRegistry.histogram({
    name: 'story_cache_purge_lag_seconds',
    help: 'Time from the event to the completed invalidation',
    labels: [],
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
  }),
  readOrigin: MetricsRegistry.counter({
    name: 'story_read_origin_total',
    help: 'Public reads that reached the origin by source (cache, durable, fallback)',
    labels: ['source'],
  }),
  sitemapAborted: MetricsRegistry.counter({
    name: 'story_sitemap_aborted_total',
    help: 'Sitemap streams stopped early by the client',
    labels: [],
  }),
  sitemapFailed: MetricsRegistry.counter({
    name: 'story_sitemap_failed_total',
    help: 'Sitemap streams that ended abnormally because the store failed',
    labels: [],
  }),
  shopCopy: MetricsRegistry.counter({
    name: 'story_shop_copy_events_total',
    help: 'Tenancy events consumed by the shop copy by result (applied, ignored, purged, dead_lettered)',
    labels: ['result'],
  }),
  deadLettered: MetricsRegistry.counter({
    name: 'story_invalidation_dead_lettered_total',
    help: 'Invalidation events sent to the dead-letter topic by reason',
    labels: ['reason'],
  }),
};

/** A purge that completes later than this after the event is alert-worthy (S27 AS-96). */
export const PURGE_LAG_ALERT_SECONDS = 60;
