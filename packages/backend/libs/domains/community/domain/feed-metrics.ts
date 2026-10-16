import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the follow graph and feed (S26 AS-50, C6). Labels are bounded outcomes only: never a user, account or
 * item id.
 */
export const feedFanoutLag = MetricsRegistry.histogram({
  name: 'feed_fanout_lag_seconds',
  help: 'Seconds from the item creation time to the end of its fan-out',
  labels: [],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300],
});

export const feedFanoutDuration = MetricsRegistry.histogram({
  name: 'feed_fanout_duration_seconds',
  help: 'Time to fan one announced item out to its active followers',
  labels: [],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
});

export const feedPushedCounter = MetricsRegistry.counter({
  name: 'feed_fanout_pushed_total',
  help: 'Timeline pushes performed by fan-out',
  labels: [],
});

export const feedSkippedInactiveCounter = MetricsRegistry.counter({
  name: 'feed_fanout_skipped_inactive_total',
  help: 'Followers not pushed to because they are not active',
  labels: [],
});

export const feedFanoutCounter = MetricsRegistry.counter({
  name: 'feed_fanout_total',
  help: 'Fan-outs by mode (push, celebrity) and outcome (completed, replayed, failed)',
  labels: ['mode', 'outcome'],
});

export const feedConsumerPausedCounter = MetricsRegistry.counter({
  name: 'feed_consumer_paused_total',
  help: 'Times the fan-out consumer paused because the timeline store was saturated',
  labels: [],
});

export const feedConsumerResumedCounter = MetricsRegistry.counter({
  name: 'feed_consumer_resumed_total',
  help: 'Times the fan-out consumer completed work again after a pause',
  labels: [],
});

export const feedRebuildCounter = MetricsRegistry.counter({
  name: 'feed_rebuild_total',
  help: 'Timeline rebuilds by outcome (complete, incomplete, joined, failed)',
  labels: ['outcome'],
});

export const feedDegradedCounter = MetricsRegistry.counter({
  name: 'feed_degraded_total',
  help: 'Feed reads served degraded, by reason (timeline_down, celebrity_timeout, hydration, history_timeout)',
  labels: ['reason'],
});

export const feedRelayBacklog = MetricsRegistry.gauge({
  name: 'feed_relay_backlog',
  help: 'Announcements stored but not yet published, as seen by the last relay run',
  labels: [],
});

export const feedRelayCounter = MetricsRegistry.counter({
  name: 'feed_announcement_relay_total',
  help: 'Announcements by relay result (published, failed, dead)',
  labels: ['result'],
});

export const feedItemCounter = MetricsRegistry.counter({
  name: 'feed_items_total',
  help: 'Items by kind and outcome (created, duplicate, skipped, dead_lettered)',
  labels: ['kind', 'outcome'],
});

export const feedStoreErrorCounter = MetricsRegistry.counter({
  name: 'feed_store_error_total',
  help: 'Durable or cache store calls that failed or timed out, by operation kind',
  labels: ['kind'],
});

export const feedRateLimitedCounter = MetricsRegistry.counter({
  name: 'feed_rate_limited_total',
  help: 'Calls refused by a follow or feed rate limit policy',
  labels: ['policy'],
});
