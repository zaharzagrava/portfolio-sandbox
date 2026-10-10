import * as joi from 'joi';

/**
 * Validated settings of `discovery` recommendations (S34 FR-029, A17). Defaults are applied here (the loader keeps the
 * raw value); an invalid value fails startup naming the key (never the value).
 */
export interface RecommendationsConfig {
  rec_min_co_orders: number;
  rec_min_buyers: number;
  rec_top_n: number;
  rec_window_days: number;
  rec_buckets: number;
  rec_ttl_seconds: number;
  rec_expand_seeds: number;
  rec_hop_decay: number;
  rec_store_budget_ms: number;
  rec_product_budget_ms: number;
  rec_shop_budget_ms: number;
  rec_basket_min: number;
  rec_basket_max: number;
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

export const recommendationsConfigKeys: Record<
  keyof RecommendationsConfig,
  Key
> = {
  rec_min_co_orders: int('REC_MIN_CO_ORDERS', 3, 1, 1_000_000),
  rec_min_buyers: int('REC_MIN_BUYERS', 3, 1, 1_000_000),
  rec_top_n: int('REC_TOP_N', 20, 1, 20),
  rec_window_days: int('REC_WINDOW_DAYS', 180, 1, 390),
  rec_buckets: int('REC_BUCKETS', 16, 1, 256),
  rec_ttl_seconds: int('REC_TTL_SECONDS', 259_200, 1, 31_536_000),
  rec_expand_seeds: int('REC_EXPAND_SEEDS', 5, 1, 20),
  rec_hop_decay: {
    name: 'REC_HOP_DECAY',
    verify: joi.number().greater(0).less(1).required(),
    postProcess: fallbackTo(0.5),
  },
  rec_store_budget_ms: int('REC_STORE_BUDGET_MS', 100, 1, 60_000),
  rec_product_budget_ms: int('REC_PRODUCT_BUDGET_MS', 100, 1, 60_000),
  rec_shop_budget_ms: int('REC_SHOP_BUDGET_MS', 50, 1, 60_000),
  rec_basket_min: int('REC_BASKET_MIN', 2, 2, 1_000),
  rec_basket_max: int('REC_BASKET_MAX', 30, 2, 1_000),
};
