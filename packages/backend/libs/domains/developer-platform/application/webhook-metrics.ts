import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Metrics of S43 FR-052. Closed label sets: never a URL, path, secret, signature, endpoint or shop identifier (the
 * registry refuses such labels). Instruments are created on first use so a spec can read them by name.
 */
export const webhookMetrics = {
  attempts: () =>
    MetricsRegistry.counter({
      name: 'webhook_delivery_attempts_total',
      help: 'Delivery attempts by outcome (delivered, failed, timeout, blocked, breaker_skipped, cancelled)',
      labels: ['outcome'],
    }),
  duration: () =>
    MetricsRegistry.histogram({
      name: 'webhook_delivery_duration_seconds',
      help: 'Duration of one attempt to a receiver',
      labels: [],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    }),
  routingLag: () =>
    MetricsRegistry.histogram({
      name: 'webhook_routing_lag_seconds',
      help: 'Time from the source event to the delivery being queued',
      labels: [],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
    }),
  laneAge: () =>
    MetricsRegistry.gauge({
      name: 'webhook_lane_age_seconds',
      help: 'Age of the oldest queued delivery seen by a worker',
      labels: [],
    }),
  breakerOpen: () =>
    MetricsRegistry.gauge({
      name: 'webhook_endpoints_breaker_open',
      help: 'Endpoints whose circuit breaker was seen open',
      labels: [],
    }),
  breakerDegraded: () =>
    MetricsRegistry.counter({
      name: 'webhook_breaker_degraded_total',
      help: 'Deliveries sent as if the breaker were closed because its store failed',
      labels: [],
    }),
  autoDisabled: () =>
    MetricsRegistry.counter({
      name: 'webhook_auto_disabled_total',
      help: 'Endpoints switched off after three days of failure',
      labels: [],
    }),
  deadLettered: () =>
    MetricsRegistry.counter({
      name: 'webhook_dead_lettered_total',
      help: 'Messages dead-lettered by lane (router, delivery)',
      labels: ['lane'],
    }),
};

const COUNTED_LIMIT = 5_000;
const counted = new Set<string>();

/**
 * Counts one dead-lettered message on its lane (FR-052). A router event is retried by the consumer framework several times
 * before it is dead-lettered, and every retry throws again, so `key` (the source event id) is counted once per process; a
 * delivery message without a usable id passes no key and is always counted.
 */
export function recordDeadLetter(
  lane: 'router' | 'delivery',
  key?: string,
): void {
  if (key !== undefined) {
    const id = `${lane}:${key}`;
    if (counted.has(id)) return;
    counted.add(id);
    if (counted.size > COUNTED_LIMIT)
      counted.delete(counted.values().next().value as string);
  }
  webhookMetrics.deadLettered().add(1, { lane });
}

const openEndpoints = new Set<string>();

/**
 * `webhook_endpoints_breaker_open`: the endpoints this process has seen with an open breaker (opened by a failure or found
 * open by a delivery) and not seen closed again since. A disposable per-process view; the breaker state itself lives in
 * the fast store.
 */
export const breakerWatch = {
  opened(endpointId: string): void {
    openEndpoints.add(endpointId);
    webhookMetrics.breakerOpen().set(openEndpoints.size);
  },
  closed(endpointId: string): void {
    if (openEndpoints.delete(endpointId))
      webhookMetrics.breakerOpen().set(openEndpoints.size);
  },
};
