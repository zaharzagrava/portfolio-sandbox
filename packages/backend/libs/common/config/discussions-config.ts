import * as joi from 'joi';

/**
 * Validated settings of `community` discussions (S25 plan, T003). Defaults are applied here (the loader keeps the raw
 * value); an invalid value fails startup naming the key, never the value. Tests override the partition size and the
 * ranking cap through the mock configuration service.
 */
export interface DiscussionsConfig {
  discussions_partition_size: number;
  discussions_ranking_cap: number;
  discussions_ranking_ttl_seconds: number;
  discussions_count_ttl_seconds: number;
  discussions_page_cache_seconds: number;
  discussions_scylla_read_timeout_ms: number;
  discussions_scylla_write_timeout_ms: number;
  discussions_redis_timeout_ms: number;
  discussions_directory_timeout_ms: number;
  discussions_catalog_timeout_ms: number;
  discussions_write_budget_ms: number;
  discussions_page_default: number;
  discussions_page_max: number;
  discussions_scan_cap: number;
  discussions_replies_embedded: number;
  discussions_max_depth: number;
  discussions_account_age_hours: number;
  discussions_anomaly_threshold: number;
  discussions_anomaly_window_seconds: number;
  discussions_degraded_window: number;
  discussions_cursor_secret: string;
}

/** Development-only HMAC secret of keyset cursors; production refuses to start with it (T079, AS-39). */
export const DEV_DISCUSSIONS_CURSOR_SECRET =
  'dev-only-discussions-cursor-secret';

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const int = (
  name: string,
  fallback: number,
  min: number,
  max: number,
): Key => ({
  name,
  verify: joi.number().integer().min(min).max(max).required(),
  postProcess: ((v: unknown) =>
    v === undefined ? fallback : Number(v)) as never,
});

export const discussionsConfigKeys: Record<keyof DiscussionsConfig, Key> = {
  discussions_partition_size: int('DISCUSSIONS_PARTITION_SIZE', 5_000, 1, 1e6),
  discussions_ranking_cap: int('DISCUSSIONS_RANKING_CAP', 1_000, 1, 100_000),
  discussions_ranking_ttl_seconds: int(
    'DISCUSSIONS_RANKING_TTL_SECONDS',
    21_600,
    1,
    604_800,
  ),
  discussions_count_ttl_seconds: int(
    'DISCUSSIONS_COUNT_TTL_SECONDS',
    3_600,
    1,
    604_800,
  ),
  discussions_page_cache_seconds: int(
    'DISCUSSIONS_PAGE_CACHE_SECONDS',
    5,
    1,
    60,
  ),
  discussions_scylla_read_timeout_ms: int(
    'DISCUSSIONS_SCYLLA_READ_TIMEOUT_MS',
    800,
    1,
    60_000,
  ),
  discussions_scylla_write_timeout_ms: int(
    'DISCUSSIONS_SCYLLA_WRITE_TIMEOUT_MS',
    1_500,
    1,
    60_000,
  ),
  discussions_redis_timeout_ms: int(
    'DISCUSSIONS_REDIS_TIMEOUT_MS',
    150,
    1,
    60_000,
  ),
  discussions_directory_timeout_ms: int(
    'DISCUSSIONS_DIRECTORY_TIMEOUT_MS',
    300,
    1,
    60_000,
  ),
  discussions_catalog_timeout_ms: int(
    'DISCUSSIONS_CATALOG_TIMEOUT_MS',
    300,
    1,
    60_000,
  ),
  discussions_write_budget_ms: int(
    'DISCUSSIONS_WRITE_BUDGET_MS',
    2_000,
    1,
    60_000,
  ),
  discussions_page_default: int('DISCUSSIONS_PAGE_DEFAULT', 25, 1, 50),
  discussions_page_max: int('DISCUSSIONS_PAGE_MAX', 50, 1, 500),
  discussions_scan_cap: int('DISCUSSIONS_SCAN_CAP', 20_000, 1, 1e6),
  discussions_replies_embedded: int('DISCUSSIONS_REPLIES_EMBEDDED', 5, 1, 50),
  discussions_max_depth: int('DISCUSSIONS_MAX_DEPTH', 8, 1, 32),
  discussions_account_age_hours: int(
    'DISCUSSIONS_ACCOUNT_AGE_HOURS',
    24,
    0,
    8_760,
  ),
  discussions_anomaly_threshold: int(
    'DISCUSSIONS_ANOMALY_THRESHOLD',
    10,
    1,
    100_000,
  ),
  discussions_anomaly_window_seconds: int(
    'DISCUSSIONS_ANOMALY_WINDOW_SECONDS',
    600,
    1,
    86_400,
  ),
  discussions_degraded_window: int(
    'DISCUSSIONS_DEGRADED_WINDOW',
    200,
    1,
    5_000,
  ),
  discussions_cursor_secret: {
    name: 'DISCUSSIONS_CURSOR_SECRET',
    verify: joi.string().min(16).required(),
    postProcess: ((v: unknown) =>
      typeof v === 'string' && v !== ''
        ? v
        : DEV_DISCUSSIONS_CURSOR_SECRET) as never,
  },
};
