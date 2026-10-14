/**
 * The settings of `auctions` as the application reads them (S21 FR-024, FR-038; research R-14). The keys, defaults
 * and cross-field startup rules live with the other platform settings in `@app/common/config/auctions-config`; this
 * is the typed snapshot the services use, taken through any `{ get(key) }` (the platform config service).
 */
export interface AuctionSettings {
  snipeWindowMs: number;
  snipeExtensionMs: number;
  snipeCapMs: number;
  sweepIntervalS: number;
  holdDeadlineS: number;
  minLeadMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  winnerWindowMs: number;
  offerWindowMs: number;
  viewCacheMs: number;
  orderMaxAttempts: number;
  maxAmountMinor: number;
  partitionMonthsAhead: number;
  aliasSecret: string;
}

type Getter = { get(key: never): unknown };

const HOUR = 3_600_000;

export function readAuctionSettings(
  config: Getter,
  aliasSecret: string,
): AuctionSettings {
  const get = (key: string): number =>
    Number((config as { get(k: string): unknown }).get(key));
  return {
    snipeWindowMs: get('auctions_snipe_window_ms'),
    snipeExtensionMs: get('auctions_snipe_extension_ms'),
    snipeCapMs: get('auctions_snipe_cap_ms'),
    sweepIntervalS: get('auctions_sweep_interval_s'),
    holdDeadlineS: get('auctions_hold_deadline_s'),
    minLeadMs: get('auctions_min_lead_s') * 1000,
    minDurationMs: get('auctions_min_duration_s') * 1000,
    maxDurationMs: get('auctions_max_duration_s') * 1000,
    winnerWindowMs: get('auctions_winner_window_h') * HOUR,
    offerWindowMs: get('auctions_offer_window_h') * HOUR,
    viewCacheMs: get('auctions_view_cache_ms'),
    orderMaxAttempts: get('auctions_order_max_attempts'),
    maxAmountMinor: get('auctions_max_amount_minor'),
    partitionMonthsAhead: get('auctions_partition_months_ahead'),
    aliasSecret,
  };
}
