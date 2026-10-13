import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of share links (S37 G21, AS-63). Labels are bounded outcomes only: never a code, destination, referrer,
 * owner or visitor value.
 */
export const linkCreatedCounter = MetricsRegistry.counter({
  name: 'link_created_total',
  help: 'Short links created, by kind (generated, custom)',
  labels: ['kind'],
});

export const linkRedirectCounter = MetricsRegistry.counter({
  name: 'link_redirect_total',
  help: 'Redirect requests by outcome (redirected, not_found, gone, unavailable)',
  labels: ['outcome'],
});

export const linkResolveCounter = MetricsRegistry.counter({
  name: 'link_resolve_total',
  help: 'Where a redirect lookup was answered (filter_reject, cache, store)',
  labels: ['source'],
});

export const linkFilterBypassedCounter = MetricsRegistry.counter({
  name: 'link_filter_bypassed_total',
  help: 'Lookups that bypassed the existence filter because it is not ready or unavailable',
  labels: [],
});

export const linkCodeCollisionCounter = MetricsRegistry.counter({
  name: 'link_code_collision_total',
  help: 'Generated codes that collided with a stored link',
  labels: [],
});

export const linkDestinationRejectedCounter = MetricsRegistry.counter({
  name: 'link_destination_rejected_total',
  help: 'Stored destinations refused at redirect time',
  labels: [],
});

export const linkClickPublishFailedCounter = MetricsRegistry.counter({
  name: 'link_click_publish_failed_total',
  help: 'Click events that could not be published',
  labels: [],
});

export const linkClickProjectedCounter = MetricsRegistry.counter({
  name: 'link_click_projected_total',
  help: 'Click events written to analytics',
  labels: [],
});

export const linkClickDeadLetteredCounter = MetricsRegistry.counter({
  name: 'link_click_dead_lettered_total',
  help: 'Click events refused by the consumer, by reason',
  labels: ['reason'],
});

export const linkClickConsumerLagGauge = MetricsRegistry.gauge({
  name: 'link_click_consumer_lag',
  help: 'Seconds between the newest projected click and the time it was projected',
  labels: [],
});
