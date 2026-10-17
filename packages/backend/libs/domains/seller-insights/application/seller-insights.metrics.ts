import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of seller insights (S40 FR-046, AS-61). Labels are bounded outcomes and feed names only: never a shop,
 * order or buyer id.
 */
export type BoardOutcome =
  | 'applied'
  | 'duplicate'
  | 'sealed'
  | 'rejected'
  | 'category_unresolved'
  | 'stale';

/** `shop_missing`: a reservation listed no shop for one of its slots (nothing to count). */
export type LiveEventOutcome =
  'applied' | 'duplicate' | 'stale' | 'shop_missing';

const boardEvents = MetricsRegistry.counter({
  name: 'leaderboard_events_total',
  help: 'Outcomes of the board feed (applied, duplicate and sealed per event and period; rejected per message; category_unresolved per line) and stale live events',
  labels: ['outcome'],
});

const liveEvents = MetricsRegistry.counter({
  name: 'seller_insights_live_events_total',
  help: 'Outcomes of the live counter feed per event and shop (applied, duplicate, stale)',
  labels: ['outcome'],
});

const deadLetters = MetricsRegistry.counter({
  name: 'seller_insights_dead_letters_total',
  help: 'Messages dead-lettered by a seller-insights consumer, by feed and reason code',
  labels: ['feed', 'reason'],
});

const ticksSkipped = MetricsRegistry.counter({
  name: 'seller_insights_dashboard_ticks_skipped_total',
  help: 'Dashboard ticks skipped because the previous tick was still running',
  labels: [],
});

const framesComputed = MetricsRegistry.counter({
  name: 'seller_insights_dashboard_frames_total',
  help: 'Dashboard frames computed (and published) for watched shops',
  labels: [],
});

const rateLimitDegraded = MetricsRegistry.counter({
  name: 'seller_insights_rate_limit_degraded_total',
  help: 'Public top-list requests served while the rate limiter store was unavailable (fail open)',
  labels: [],
});

const feedLag = MetricsRegistry.gauge({
  name: 'seller_insights_feed_lag_seconds',
  help: 'Age of the oldest event not yet processed by each feed, by feed name',
  labels: ['feed'],
});

const countByOutcome = (name: string, labels: Record<string, string>) =>
  MetricsRegistry.value(name, labels) ?? 0;

export const insightsMetrics = {
  board: (outcome: BoardOutcome, count = 1) =>
    boardEvents.add(count, { outcome }),
  live: (outcome: LiveEventOutcome, count = 1) => {
    liveEvents.add(count, { outcome });
    if (outcome === 'stale') boardEvents.add(count, { outcome: 'stale' });
  },
  deadLetter: (feed: string, reason: string) =>
    deadLetters.add(1, { feed, reason }),
  tickSkipped: () => ticksSkipped.add(1),
  frameComputed: () => framesComputed.add(1),
  rateLimitDegraded: () => rateLimitDegraded.add(1),
  /** Seconds the oldest unprocessed event of `feed` has waited (0 = caught up). */
  lag: (feed: string, seconds: number) => feedLag.set(seconds, { feed }),
  /** Spec reads. */
  value: {
    board: (outcome: BoardOutcome) =>
      countByOutcome('leaderboard_events_total', { outcome }),
    live: (outcome: LiveEventOutcome) =>
      countByOutcome('seller_insights_live_events_total', { outcome }),
    deadLetter: (feed: string, reason: string) =>
      countByOutcome('seller_insights_dead_letters_total', { feed, reason }),
    ticksSkipped: () =>
      MetricsRegistry.value('seller_insights_dashboard_ticks_skipped_total') ??
      0,
    frames: () =>
      MetricsRegistry.value('seller_insights_dashboard_frames_total') ?? 0,
    rateLimitDegraded: () =>
      MetricsRegistry.value('seller_insights_rate_limit_degraded_total') ?? 0,
    lag: (feed: string) =>
      MetricsRegistry.value('seller_insights_feed_lag_seconds', { feed }),
  },
};
