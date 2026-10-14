import * as joi from 'joi';
import { ConfigRules, RuleCheck } from './config-rules';

/**
 * Validated settings of `auctions` (S21 FR-024, FR-038, research R-14). Defaults are applied here (the loader keeps
 * the raw value); the cross-field rules run at startup in `auctionsRule`.
 */
export interface AuctionsConfig {
  auctions_snipe_window_ms: number;
  auctions_snipe_extension_ms: number;
  auctions_snipe_cap_ms: number;
  auctions_sweep_interval_s: number;
  auctions_hold_deadline_s: number;
  auctions_min_lead_s: number;
  auctions_min_duration_s: number;
  auctions_max_duration_s: number;
  auctions_winner_window_h: number;
  auctions_offer_window_h: number;
  auctions_view_cache_ms: number;
  auctions_order_max_attempts: number;
  auctions_max_amount_minor: number;
  auctions_partition_months_ahead: number;
  auctions_alias_secret: string;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const num = (name: string, fallback: number, min = 1): Key => ({
  name,
  verify: joi.number().integer().min(min).required(),
  postProcess: ((v: unknown) =>
    v === undefined ? fallback : Number(v)) as never,
});

export const auctionsConfigKeys: Record<keyof AuctionsConfig, Key> = {
  auctions_snipe_window_ms: num('AUCTIONS_SNIPE_WINDOW_MS', 120_000, 0),
  auctions_snipe_extension_ms: num('AUCTIONS_SNIPE_EXTENSION_MS', 120_000),
  auctions_snipe_cap_ms: num('AUCTIONS_SNIPE_CAP_MS', 3_600_000),
  auctions_sweep_interval_s: num('AUCTIONS_SWEEP_INTERVAL_S', 30),
  auctions_hold_deadline_s: num('AUCTIONS_HOLD_DEADLINE_S', 300),
  auctions_min_lead_s: num('AUCTIONS_MIN_LEAD_S', 60, 0),
  auctions_min_duration_s: num('AUCTIONS_MIN_DURATION_S', 600),
  auctions_max_duration_s: num('AUCTIONS_MAX_DURATION_S', 2_592_000),
  auctions_winner_window_h: num('AUCTIONS_WINNER_WINDOW_H', 48),
  auctions_offer_window_h: num('AUCTIONS_OFFER_WINDOW_H', 24),
  auctions_view_cache_ms: num('AUCTIONS_VIEW_CACHE_MS', 1_000),
  auctions_order_max_attempts: num('AUCTIONS_ORDER_MAX_ATTEMPTS', 8),
  auctions_max_amount_minor: num(
    'AUCTIONS_MAX_AMOUNT_MINOR',
    1_000_000_000_000,
  ),
  auctions_partition_months_ahead: num('AUCTIONS_PARTITION_MONTHS_AHEAD', 3, 0),
  auctions_alias_secret: {
    name: 'AUCTIONS_ALIAS_SECRET',
    verify: joi.string().optional().allow(''),
  },
};

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/** Cross-field rules (R-14): a key missing here falls back to the default of its key. */
export const auctionsRule: RuleCheck = (ctx) => {
  const n = (key: keyof AuctionsConfig, fallback: number): number => {
    const v = ctx.get(key);
    return isSet(v) ? Number(v) : fallback;
  };
  const found: string[] = [];
  if (n('auctions_snipe_window_ms', 120_000) < 0)
    found.push('auctions_snipe_window_ms must be at least 0');
  if (n('auctions_snipe_extension_ms', 120_000) <= 0)
    found.push('auctions_snipe_extension_ms must be above 0');
  if (
    n('auctions_snipe_cap_ms', 3_600_000) <
    n('auctions_snipe_extension_ms', 120_000)
  )
    found.push(
      'auctions_snipe_cap_ms must be at least auctions_snipe_extension_ms',
    );
  if (
    n('auctions_min_duration_s', 600) >= n('auctions_max_duration_s', 2_592_000)
  )
    found.push(
      'auctions_min_duration_s must be less than auctions_max_duration_s',
    );
  if (n('auctions_hold_deadline_s', 300) <= n('auctions_sweep_interval_s', 30))
    found.push(
      'auctions_hold_deadline_s must be above auctions_sweep_interval_s',
    );
  if (
    n('auctions_max_amount_minor', 1_000_000_000_000) > Number.MAX_SAFE_INTEGER
  )
    found.push('auctions_max_amount_minor must be a safe integer');
  const secret = ctx.get('auctions_alias_secret');
  if (ctx.production && !isSet(secret))
    found.push('auctions_alias_secret is required');
  if (isSet(secret) && Buffer.byteLength(String(secret)) < 32)
    found.push('auctions_alias_secret must be at least 32 bytes');
  return found;
};

ConfigRules.register({
  owner: 'auctions',
  keys: [
    'auctions_snipe_window_ms',
    'auctions_snipe_extension_ms',
    'auctions_snipe_cap_ms',
    'auctions_min_duration_s',
    'auctions_max_duration_s',
    'auctions_hold_deadline_s',
    'auctions_sweep_interval_s',
    'auctions_max_amount_minor',
    'auctions_alias_secret',
  ],
  validate: auctionsRule,
});
