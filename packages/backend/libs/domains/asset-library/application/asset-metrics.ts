import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * The series of S31 AS-73 through the S54 registry (names and bounded labels are checked at registration). No shop,
 * asset, token or path is ever a label; those belong in logs and traces.
 */
export const assetMetrics = {
  prepareChunks: MetricsRegistry.counter({
    name: 'assets_prepare_chunks_total',
    help: 'Distinct chunks of prepare calls by result (missing, stored)',
    labels: ['result'],
  }),
  commits: MetricsRegistry.counter({
    name: 'assets_commit_total',
    help: 'Commits by outcome (created, updated, conflicted_copy, unchanged, rejected)',
    labels: ['outcome'],
  }),
  gcDeleted: MetricsRegistry.counter({
    name: 'assets_gc_deleted_total',
    help: 'Chunks removed by cleanup (object first, then row)',
    labels: [],
  }),
  gcFailures: MetricsRegistry.counter({
    name: 'assets_gc_failures_total',
    help: 'Cleanup deletes that failed and were kept for the next run',
    labels: [],
  }),
  shareRedeems: MetricsRegistry.counter({
    name: 'assets_share_redeem_total',
    help: 'Share link redeems by outcome (ok, unavailable, limited)',
    labels: ['outcome'],
  }),
  downloads: MetricsRegistry.counter({
    name: 'assets_download_total',
    help: 'Downloads by kind (share, purchase) and outcome (ok, unavailable, aborted)',
    labels: ['kind', 'outcome'],
  }),
  entitlements: MetricsRegistry.counter({
    name: 'assets_entitlement_total',
    help: 'Entitlement events by kind (granted, revoked, ignored, dead_lettered)',
    labels: ['event'],
  }),
  realtimeFailures: MetricsRegistry.counter({
    name: 'assets_realtime_publish_failures_total',
    help: 'assets.changed notifications that could not be published',
    labels: [],
  }),
  storageFailures: MetricsRegistry.counter({
    name: 'assets_storage_failures_total',
    help: 'Storage calls that failed or timed out, by operation',
    labels: ['operation'],
  }),
  rateLimited: MetricsRegistry.counter({
    name: 'assets_rate_limited_total',
    help: 'Calls refused by an asset-library rate limit, by policy',
    labels: ['policy'],
  }),
  storageBytes: MetricsRegistry.gauge({
    name: 'assets_storage_bytes',
    help: 'Bytes held by chunk rows, summed per shop size tier (small, medium, large) and state (stored, reserved)',
    labels: ['tier', 'state'],
  }),
  entitlementLag: MetricsRegistry.histogram({
    name: 'assets_entitlement_lag_seconds',
    help: 'Time from the order event to the entitlement being granted or revoked',
    labels: ['event'],
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 300],
  }),
};
