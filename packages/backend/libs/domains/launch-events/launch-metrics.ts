import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * The `launch_*` series of S22 AS-58 through the S54 registry (names and bounded labels are checked at registration).
 * No event, user, ticket, token or idempotency key is ever a label; those belong in logs and traces. The queue-length
 * gauge is the one series with an event label, and it is set for `ON_SALE` events only.
 */
export const launchMetrics = {
  joins: MetricsRegistry.counter({
    name: 'launch_queue_joins_total',
    help: 'Waiting-room joins by result (created, existing, full, unavailable, closed, human_check_failed)',
    labels: ['result'],
  }),
  queueLength: MetricsRegistry.gauge({
    name: 'launch_queue_length',
    help: 'Tickets waiting, per event on sale',
    labels: ['event'],
  }),
  admitted: MetricsRegistry.counter({
    name: 'launch_admitted_total',
    help: 'Tickets admitted',
    labels: [],
  }),
  staleLeader: MetricsRegistry.counter({
    name: 'launch_admission_stale_leader_total',
    help: 'Admission writes refused because the admitter epoch was stale',
    labels: [],
  }),
  holds: MetricsRegistry.counter({
    name: 'launch_holds_total',
    help: 'Hold attempts by outcome (created, seat_taken, limit, admission_refused, unavailable, no_seats)',
    labels: ['outcome'],
  }),
  holdDegraded: MetricsRegistry.counter({
    name: 'launch_hold_degraded_total',
    help: 'Holds served with a store down, by store (locks, quota, map, limiter)',
    labels: ['store'],
  }),
  confirms: MetricsRegistry.counter({
    name: 'launch_confirms_total',
    help: 'Confirm attempts by outcome (confirmed, replay, expired, seat_taken, conflict, failed)',
    labels: ['outcome'],
  }),
  doubleBooking: MetricsRegistry.counter({
    name: 'launch_double_booking_detected_total',
    help: 'Seats found with more than one confirmed booking (must stay 0)',
    labels: [],
  }),
  reconcileRepairs: MetricsRegistry.counter({
    name: 'launch_reconcile_repairs_total',
    help: 'Drift repaired by the reconciler, by kind',
    labels: ['kind'],
  }),
  rollbackFailed: MetricsRegistry.counter({
    name: 'launch_rollback_failed_total',
    help: 'Seat records that could not be freed (the reconciler repairs them)',
    labels: [],
  }),
  publishFailed: MetricsRegistry.counter({
    name: 'launch_publish_failed_total',
    help: 'Realtime publishes that failed',
    labels: [],
  }),
  limiterFailures: MetricsRegistry.counter({
    name: 'launch_limiter_failures_total',
    help: 'Rate-limit checks that could not be answered, by policy',
    labels: ['policy'],
  }),
};
