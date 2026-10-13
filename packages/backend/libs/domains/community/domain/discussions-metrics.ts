import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of discussions (S25 G4, AS-54). Labels are bounded outcomes only: never a user, post or board id.
 */
export const discussionWriteCounter = MetricsRegistry.counter({
  name: 'discussions_write_total',
  help: 'Writes by kind (post, comment, post_delete, comment_delete) and outcome (created, replayed, rejected, failed)',
  labels: ['kind', 'outcome'],
});

export const discussionVoteCounter = MetricsRegistry.counter({
  name: 'discussions_vote_total',
  help: 'Votes by outcome (cast, changed, retracted, replayed, rejected, unavailable, busy)',
  labels: ['outcome'],
});

export const discussionRateLimitedCounter = MetricsRegistry.counter({
  name: 'discussions_rate_limited_total',
  help: 'Calls refused by a discussions rate limit policy',
  labels: ['policy'],
});

export const discussionDegradedCounter = MetricsRegistry.counter({
  name: 'discussions_degraded_read_total',
  help: 'Reads answered from the durable store because the ranking cache was unavailable',
  labels: ['list'],
});

export const discussionDriftCounter = MetricsRegistry.counter({
  name: 'discussions_drift_repaired_total',
  help: 'Counts repaired by reconciliation',
  labels: ['kind'],
});

export const discussionAnomalyCounter = MetricsRegistry.counter({
  name: 'discussions_vote_anomaly_total',
  help: 'Vote anomaly signals recorded',
  labels: [],
});

export const discussionStoreErrorCounter = MetricsRegistry.counter({
  name: 'discussions_store_error_total',
  help: 'Durable store calls that failed or timed out, by operation kind',
  labels: ['kind'],
});

export const discussionRelayCounter = MetricsRegistry.counter({
  name: 'discussions_event_relay_total',
  help: 'Recorded events by relay result (published, failed, dead)',
  labels: ['result'],
});

export const discussionStoreSeconds = MetricsRegistry.histogram({
  name: 'discussions_store_seconds',
  help: 'Durable store call duration by kind',
  labels: ['kind'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
});
