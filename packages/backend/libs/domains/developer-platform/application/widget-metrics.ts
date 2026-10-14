import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Counters of AS-52. Closed label sets: never a key, a secret, a token, an e-mail, an origin or a shop identifier.
 * The counters are created on first use, so a spec can read them by name from the registry.
 */
export const widgetMetrics = {
  config: () =>
    MetricsRegistry.counter({
      name: 'widget_config_requests_total',
      help: 'Widget configuration requests by result (ok, stale, origin_rejected, unknown_key, disabled, unavailable)',
      labels: ['result'],
    }),
  identify: () =>
    MetricsRegistry.counter({
      name: 'widget_identify_total',
      help: 'Identity hand-off exchanges by result (ok, invalid, replay, origin_rejected, disabled, unavailable, rate_limited)',
      labels: ['result'],
    }),
  embed: () =>
    MetricsRegistry.counter({
      name: 'widget_embed_total',
      help: 'Embed document requests by result',
      labels: ['result'],
    }),
  killSwitch: () =>
    MetricsRegistry.counter({
      name: 'widget_kill_switch_total',
      help: 'Kill switch changes by new state',
      labels: ['state'],
    }),
  originRejected: () =>
    MetricsRegistry.counter({
      name: 'widget_origin_rejected_total',
      help: 'Widget requests refused because the origin is not registered',
      labels: [],
    }),
  singleUseFallback: () =>
    MetricsRegistry.counter({
      name: 'widget_single_use_unavailable_total',
      help: 'Hand-off exchanges answered 503 because the single-use store failed',
      labels: [],
    }),
  limiterFallback: () =>
    MetricsRegistry.counter({
      name: 'widget_limiter_unavailable_total',
      help: 'Widget identify requests answered 503 because the limiter store failed',
      labels: [],
    }),
  identifyInvalidReason: () =>
    MetricsRegistry.counter({
      name: 'widget_identify_rejected_total',
      help: 'Hand-off rejections by closed reason',
      labels: ['reason'],
    }),
  consumer: () =>
    MetricsRegistry.counter({
      name: 'widget_consumer_events_total',
      help: 'Shop events consumed by the widget by type and result',
      labels: ['type', 'result'],
    }),
};
