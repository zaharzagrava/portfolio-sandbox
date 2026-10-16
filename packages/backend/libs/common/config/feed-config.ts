import * as joi from 'joi';

/**
 * Validated settings of the follow graph and home feed (S26 plan, T004). Defaults are applied here (the loader keeps
 * the raw value); an invalid value fails startup naming the key, never the value. Tests lower the thresholds, windows
 * and page sizes through the mock configuration service.
 */
export interface FeedConfig {
  feed_celebrity_threshold: number;
  feed_following_limit: number;
  feed_timeline_window: number;
  feed_celebrity_recents: number;
  feed_retention_days: number;
  feed_active_window_days: number;
  feed_fanout_page_size: number;
  feed_rebuild_concurrency: number;
  feed_rebuild_semaphore: number;
  feed_timeline_timeout_ms: number;
  feed_celebrity_timeout_ms: number;
  feed_history_timeout_ms: number;
  feed_hydration_timeout_ms: number;
  feed_directory_timeout_ms: number;
  feed_scan_cap_factor: number;
  feed_cursor_secret: string;
}

/** Development-only HMAC secret of feed cursors; production refuses to start with it (see config-rules). */
export const DEV_FEED_CURSOR_SECRET = 'dev-only-feed-cursor-secret';

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

export const feedConfigKeys: Record<keyof FeedConfig, Key> = {
  feed_celebrity_threshold: int('FEED_CELEBRITY_THRESHOLD', 10_000, 1, 1e9),
  feed_following_limit: int('FEED_FOLLOWING_LIMIT', 2_000, 1, 100_000),
  feed_timeline_window: int('FEED_TIMELINE_WINDOW', 800, 1, 100_000),
  feed_celebrity_recents: int('FEED_CELEBRITY_RECENTS', 200, 1, 10_000),
  feed_retention_days: int('FEED_RETENTION_DAYS', 90, 1, 3_650),
  feed_active_window_days: int('FEED_ACTIVE_WINDOW_DAYS', 7, 1, 365),
  feed_fanout_page_size: int('FEED_FANOUT_PAGE_SIZE', 1_000, 1, 1_000),
  feed_rebuild_concurrency: int('FEED_REBUILD_CONCURRENCY', 16, 1, 256),
  feed_rebuild_semaphore: int('FEED_REBUILD_SEMAPHORE', 64, 1, 1_024),
  feed_timeline_timeout_ms: int('FEED_TIMELINE_TIMEOUT_MS', 150, 1, 60_000),
  feed_celebrity_timeout_ms: int('FEED_CELEBRITY_TIMEOUT_MS', 400, 1, 60_000),
  feed_history_timeout_ms: int('FEED_HISTORY_TIMEOUT_MS', 800, 1, 60_000),
  feed_hydration_timeout_ms: int('FEED_HYDRATION_TIMEOUT_MS', 600, 1, 60_000),
  feed_directory_timeout_ms: int('FEED_DIRECTORY_TIMEOUT_MS', 300, 1, 60_000),
  feed_scan_cap_factor: int('FEED_SCAN_CAP_FACTOR', 5, 1, 100),
  feed_cursor_secret: {
    name: 'FEED_CURSOR_SECRET',
    verify: joi.string().min(16).required(),
    postProcess: ((v: unknown) =>
      typeof v === 'string' && v !== '' ? v : DEV_FEED_CURSOR_SECRET) as never,
  },
};
