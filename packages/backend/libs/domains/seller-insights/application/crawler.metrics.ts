import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the competitor crawler (S41 FR-033, AS-55). Labels are bounded outcomes only: never a URL, host,
 * shop or target id.
 */
const fetches = MetricsRegistry.counter({
  name: 'crawler_fetch_total',
  help: 'Crawls of a target by outcome (ok, unchanged, no_price, disallowed_by_robots, blocked_address, http_429, ...)',
  labels: ['outcome'],
});
const robots = MetricsRegistry.counter({
  name: 'crawler_robots_total',
  help: 'robots.txt lookups by result (hit, fetched, unavailable)',
  labels: ['result'],
});
const alerts = MetricsRegistry.counter({
  name: 'crawler_alert_events_total',
  help: 'Competitor price drop events written to the outbox',
  labels: [],
});
const archiveFailed = MetricsRegistry.counter({
  name: 'crawler_archive_failed_total',
  help: 'Changed pages that could not be archived',
  labels: [],
});
const truncated = MetricsRegistry.counter({
  name: 'crawler_truncated_total',
  help: 'Pages cut at the body cap',
  labels: [],
});
const seenSet = MetricsRegistry.counter({
  name: 'seen_set_lookups_total',
  help: 'Seen-set lookups by result (definitely_new, confirmed_hit, false_positive)',
  labels: ['result'],
});
const evaluations = MetricsRegistry.counter({
  name: 'crawler_evaluations_total',
  help: 'Watch evaluations by outcome (alert, not_undercut, currency_mismatch, product_unavailable, shop_inactive, not_lower_than_previous, no_recipient)',
  labels: ['outcome'],
});
const overdue = MetricsRegistry.gauge({
  name: 'crawler_overdue_targets',
  help: 'Watched targets whose next check is in the past',
  labels: [],
});
const oldestOverdue = MetricsRegistry.gauge({
  name: 'crawler_oldest_overdue_seconds',
  help: 'Seconds the most overdue watched target has waited (0 = none)',
  labels: [],
});
const readyHosts = MetricsRegistry.gauge({
  name: 'crawler_ready_hosts',
  help: 'Hosts with queued targets in the frontier',
  labels: [],
});

const value = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

export const crawlerMetrics = {
  fetch: (outcome: string) => fetches.add(1, { outcome }),
  robots: (result: string) => robots.add(1, { result }),
  alert: (count = 1) => alerts.add(count, {}),
  archiveFailed: () => archiveFailed.add(1, {}),
  truncated: () => truncated.add(1, {}),
  seenSet: (result: 'definitely_new' | 'confirmed_hit' | 'false_positive') =>
    seenSet.add(1, { result }),
  evaluation: (outcome: string) => evaluations.add(1, { outcome }),
  overdue: (targets: number, oldestSeconds: number) => {
    overdue.set(targets, {});
    oldestOverdue.set(oldestSeconds, {});
  },
  readyHosts: (count: number) => readyHosts.set(count, {}),
  /** Spec reads. */
  value: {
    fetch: (outcome: string) => value('crawler_fetch_total', { outcome }),
    robots: (result: string) => value('crawler_robots_total', { result }),
    alerts: () => value('crawler_alert_events_total'),
    archiveFailed: () => value('crawler_archive_failed_total'),
    truncated: () => value('crawler_truncated_total'),
    seenSet: (result: string) => value('seen_set_lookups_total', { result }),
    evaluation: (outcome: string) =>
      value('crawler_evaluations_total', { outcome }),
    overdue: () => value('crawler_overdue_targets'),
    oldestOverdue: () => value('crawler_oldest_overdue_seconds'),
    readyHosts: () => value('crawler_ready_hosts'),
  },
};
