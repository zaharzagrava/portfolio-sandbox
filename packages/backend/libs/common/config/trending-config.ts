import * as joi from 'joi';

/**
 * Validated settings of `discovery` trending (S35 FR-026, AS-37). Defaults are applied here (the loader keeps the raw
 * value); an invalid value fails startup naming the key (never the value). The cross-field retention rule is checked by
 * `domain/trending-config.ts` when `TrendingSettings` is built.
 */
export interface TrendingConfig {
  trending_weight_view: number;
  trending_weight_cart: number;
  trending_window_seconds: number;
  trending_lateness_seconds: number;
  trending_idle_seconds: number;
  trending_heap_k: number;
  trending_all_width: number;
  trending_category_width: number;
  trending_depth: number;
  trending_category_cap: number;
  trending_memory_budget_mb: number;
  trending_retention_seconds: number;
  trending_aggregate_budget_ms: number;
  trending_product_budget_ms: number;
  trending_shop_budget_ms: number;
  trending_merge_budget_ms: number;
  trending_connect_timeout_ms: number;
  trending_shutdown_deadline_ms: number;
  trending_filter_bits: number;
  trending_tick_ms: number;
  trending_merge_backoff_base_ms: number;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const fallbackTo = (fallback: number) =>
  ((v: unknown) => (v === undefined ? fallback : Number(v))) as never;

const int = (
  name: string,
  fallback: number,
  min: number,
  max: number,
): Key => ({
  name,
  verify: joi.number().integer().min(min).max(max).required(),
  postProcess: fallbackTo(fallback),
});

const pow2 = (name: string, fallback: number, min: number): Key => ({
  name,
  verify: joi
    .number()
    .integer()
    .min(min)
    .custom((value, helpers) =>
      (value & (value - 1)) === 0 ? value : helpers.error('any.invalid'),
    )
    .required(),
  postProcess: fallbackTo(fallback),
});

export const trendingConfigKeys: Record<keyof TrendingConfig, Key> = {
  trending_weight_view: int('TRENDING_WEIGHT_VIEW', 1, 1, 1_000_000),
  trending_weight_cart: int('TRENDING_WEIGHT_CART', 5, 1, 1_000_000),
  trending_window_seconds: int('TRENDING_WINDOW_SECONDS', 60, 60, 60),
  trending_lateness_seconds: int('TRENDING_LATENESS_SECONDS', 120, 0, 600),
  trending_idle_seconds: int('TRENDING_IDLE_SECONDS', 30, 1, 3_600),
  trending_heap_k: int('TRENDING_HEAP_K', 50, 40, 10_000),
  trending_all_width: pow2('TRENDING_ALL_WIDTH', 1 << 16, 2),
  trending_category_width: pow2('TRENDING_CATEGORY_WIDTH', 1 << 14, 2),
  trending_depth: int('TRENDING_DEPTH', 4, 1, 8),
  trending_category_cap: int('TRENDING_CATEGORY_CAP', 100, 1, 100_000),
  trending_memory_budget_mb: int(
    'TRENDING_MEMORY_BUDGET_MB',
    512,
    1,
    1_048_576,
  ),
  trending_retention_seconds: int(
    'TRENDING_RETENTION_SECONDS',
    10_800,
    1,
    10_800,
  ),
  trending_aggregate_budget_ms: int(
    'TRENDING_AGGREGATE_BUDGET_MS',
    100,
    1,
    60_000,
  ),
  trending_product_budget_ms: int('TRENDING_PRODUCT_BUDGET_MS', 100, 1, 60_000),
  trending_shop_budget_ms: int('TRENDING_SHOP_BUDGET_MS', 50, 1, 60_000),
  trending_merge_budget_ms: int('TRENDING_MERGE_BUDGET_MS', 100, 1, 60_000),
  trending_connect_timeout_ms: int(
    'TRENDING_CONNECT_TIMEOUT_MS',
    5_000,
    1,
    600_000,
  ),
  trending_shutdown_deadline_ms: int(
    'TRENDING_SHUTDOWN_DEADLINE_MS',
    10_000,
    1,
    600_000,
  ),
  trending_filter_bits: pow2('TRENDING_FILTER_BITS', 1 << 24, 1024),
  trending_tick_ms: int('TRENDING_TICK_MS', 5_000, 1, 600_000),
  trending_merge_backoff_base_ms: int(
    'TRENDING_MERGE_BACKOFF_BASE_MS',
    100,
    1,
    60_000,
  ),
};
