import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * The `live_*` series of S23 AS-52 through the S54 registry (names and bounded labels are checked at registration). No
 * comment text, user, e-mail, token, `clientId` or stream is ever a label; those belong in logs (without the content).
 */
export const liveMetrics = {
  comments: MetricsRegistry.counter({
    name: 'live_comments_total',
    help: 'Comment posts by result (accepted, replayed, blocked, muted, rejected, unavailable) and block reason',
    labels: ['result', 'reason'],
  }),
  batchItems: MetricsRegistry.gauge({
    name: 'live_batch_items',
    help: 'Comments in the last batch written to a viewer',
    labels: [],
  }),
  windowComments: MetricsRegistry.gauge({
    name: 'live_window_comments',
    help: 'Comments seen by the sampler in the last closed window',
    labels: [],
  }),
  deliveryLag: MetricsRegistry.histogram({
    name: 'live_delivery_lag_seconds',
    help: 'From a comment being accepted to being written to a viewer',
    labels: [],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  }),
  viewers: MetricsRegistry.gauge({
    name: 'live_viewers',
    help: 'Concurrent viewers on this gateway instance',
    labels: [],
  }),
  viewersDropped: MetricsRegistry.counter({
    name: 'live_viewers_dropped_total',
    help: 'Viewers dropped by the instance, by reason (slow, shutdown, ended)',
    labels: ['reason'],
  }),
  reactions: MetricsRegistry.counter({
    name: 'live_reactions_total',
    help: 'Reactions counted',
    labels: [],
  }),
  statsPublished: MetricsRegistry.counter({
    name: 'live_stats_published_total',
    help: 'Per-second statistics events published',
    labels: [],
  }),
  removals: MetricsRegistry.counter({
    name: 'live_removals_total',
    help: 'Comments removed, by source (moderator, auto)',
    labels: ['source'],
  }),
  historyLag: MetricsRegistry.histogram({
    name: 'live_history_lag_seconds',
    help: 'From a comment being posted to being stored in the history',
    labels: [],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  }),
  consumerFailures: MetricsRegistry.counter({
    name: 'live_consumer_failures_total',
    help: 'Messages a live consumer could not process, by consumer',
    labels: ['consumer'],
  }),
  moderationFailed: MetricsRegistry.counter({
    name: 'live_moderation_failed_total',
    help: 'Comments the classifier could not score after every retry',
    labels: [],
  }),
  limiterUnavailable: MetricsRegistry.counter({
    name: 'live_limiter_unavailable_total',
    help: 'Rate-limit checks that could not be answered (the request was let through)',
    labels: ['policy'],
  }),
};
