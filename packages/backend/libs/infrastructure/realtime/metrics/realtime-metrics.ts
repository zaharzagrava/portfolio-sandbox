import { Injectable } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

export type ClosedReason =
  'client' | 'slow' | 'stalled' | 'lifetime' | 'shutdown' | 'revoked' | 'error';
export type RefusedReason =
  | 'invalid'
  | 'unauthenticated'
  | 'forbidden'
  | 'too_many'
  | 'rate_limited'
  | 'policy_unavailable'
  | 'unavailable'
  | 'capacity';

/** The hub's instruments (S51 FR-054). Labels are closed sets: never a topic, a user or a cursor. */
@Injectable()
export class RealtimeMetrics {
  readonly connections = MetricsRegistry.gauge({
    name: 'realtime_connections',
    help: 'Open stream connections on this instance',
    labels: [],
  });
  readonly subscriptions = MetricsRegistry.gauge({
    name: 'realtime_topic_subscriptions',
    help: 'Backplane channels this instance is subscribed to',
    labels: [],
  });
  readonly delivered = MetricsRegistry.counter({
    name: 'realtime_events_delivered_total',
    help: 'Events written to viewers',
    labels: ['kind'],
  });
  readonly published = MetricsRegistry.counter({
    name: 'realtime_publish_total',
    help: 'Publish calls by outcome',
    labels: ['result'],
  });
  readonly closed = MetricsRegistry.counter({
    name: 'realtime_connections_closed_total',
    help: 'Closed connections by reason',
    labels: ['reason'],
  });
  readonly refused = MetricsRegistry.counter({
    name: 'realtime_connections_refused_total',
    help: 'Refused connections by reason',
    labels: ['reason'],
  });
  readonly resync = MetricsRegistry.counter({
    name: 'realtime_resync_total',
    help: 'Resync events sent',
    labels: [],
  });
  readonly revocations = MetricsRegistry.counter({
    name: 'realtime_revocations_total',
    help: 'Topic subscriptions ended by a revocation',
    labels: [],
  });
  readonly cursorIgnored = MetricsRegistry.counter({
    name: 'realtime_cursor_ignored_total',
    help: 'Last-Event-ID entries that were unusable and ignored',
    labels: [],
  });
  readonly listenerErrors = MetricsRegistry.counter({
    name: 'realtime_listener_errors_total',
    help: 'Listeners that threw while handling a message',
    labels: [],
  });
  readonly replayOverflow = MetricsRegistry.counter({
    name: 'realtime_replay_overflow_total',
    help: 'Live messages discarded because the replay buffer overflowed',
    labels: [],
  });
  readonly latency = MetricsRegistry.histogram({
    name: 'realtime_delivery_latency_seconds',
    help: 'Time from publish to write on this instance',
    labels: [],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  });
}
