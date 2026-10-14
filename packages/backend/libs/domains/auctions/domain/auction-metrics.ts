import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of `auctions` (S21 AS-51). Labels are bounded outcomes only: never a bidder, shop or auction id (the
 * registry refuses those labels); the ids go to logs and traces.
 */
export const BID_OUTCOMES = [
  'leading',
  'outbid',
  'raised',
  'rejected_low',
  'rejected_not_increasing',
  'rejected_closed',
  'rejected_shill',
] as const;
export type BidMetricOutcome = (typeof BID_OUTCOMES)[number];

export const bidsCounter = MetricsRegistry.counter({
  name: 'auction_bids_total',
  help: 'Bids by outcome (leading, outbid, raised, rejected_low, rejected_not_increasing, rejected_closed, rejected_shill)',
  labels: ['outcome'],
});

export const bidDuration = MetricsRegistry.histogram({
  name: 'auction_bid_duration_seconds',
  help: 'Time to decide and commit one bid',
  labels: [],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
});

export const extensionsCounter = MetricsRegistry.counter({
  name: 'auction_extensions_total',
  help: 'Anti-sniping extensions of an end',
  labels: [],
});

export const closedCounter = MetricsRegistry.counter({
  name: 'auction_closed_total',
  help: 'Closes by status and reason',
  labels: ['status', 'reason'],
});

export const closeLag = MetricsRegistry.histogram({
  name: 'auction_close_lag_seconds',
  help: 'Close time minus the end of the auction',
  labels: [],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 600],
});

export const secondChanceCounter = MetricsRegistry.counter({
  name: 'auction_second_chance_total',
  help: 'Second chance results (offered, sold, unpaid, none)',
  labels: ['result'],
});

export const orderRequestFailedCounter = MetricsRegistry.counter({
  name: 'auction_order_request_failed_total',
  help: 'Order requests to the order capability that failed (transient attempt or dead letter)',
  labels: ['kind'],
});

export const settlementAnomalyCounter = MetricsRegistry.counter({
  name: 'auction_settlement_anomaly_total',
  help: 'Settlement events that arrived out of order (late_payment)',
  labels: ['kind'],
});

export const shillBlockedCounter = MetricsRegistry.counter({
  name: 'auction_shill_blocked_total',
  help: 'Bids refused because the bidder belongs to the selling shop',
  labels: [],
});

export const fastStoreFailedCounter = MetricsRegistry.counter({
  name: 'auction_fast_store_failed_total',
  help: 'Cache or limiter store operations that failed and were bypassed (kind)',
  labels: ['kind'],
});

export const realtimeFailedCounter = MetricsRegistry.counter({
  name: 'auction_realtime_failed_total',
  help: 'Realtime publishes that failed after commit',
  labels: [],
});

export const openOverdue = MetricsRegistry.gauge({
  name: 'auction_open_overdue',
  help: 'OPEN auctions more than 60 s past their end at the last sweep',
  labels: [],
});

export const defaultPartitionRows = MetricsRegistry.gauge({
  name: 'auction_bid_default_partition_rows',
  help: 'Bids that landed in the default partition because no monthly partition existed',
  labels: [],
});
