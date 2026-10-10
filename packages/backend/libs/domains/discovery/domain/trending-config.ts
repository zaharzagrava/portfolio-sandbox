/**
 * Pure rules for the trending settings (S35 FR-026, AS-37). The env mapping lives in `common/config/trending-config.ts`;
 * this file holds the defaults and every check, so the unit spec and the startup check agree.
 */
export interface TrendingSettingsValues {
  weightView: number;
  weightCart: number;
  windowSeconds: number;
  latenessSeconds: number;
  idleSeconds: number;
  heapK: number;
  allWidth: number;
  categoryWidth: number;
  depth: number;
  categoryCap: number;
  memoryBudgetMb: number;
  retentionSeconds: number;
  aggregateBudgetMs: number;
  productBudgetMs: number;
  shopBudgetMs: number;
  mergeBudgetMs: number;
  connectTimeoutMs: number;
  shutdownDeadlineMs: number;
  /** Bits of each of the two membership filters kept per open window and partition. */
  filterBits: number;
  tickMs: number;
  mergeBackoffBaseMs: number;
}

export const TRENDING_DEFAULTS: TrendingSettingsValues = {
  weightView: 1,
  weightCart: 5,
  windowSeconds: 60,
  latenessSeconds: 120,
  idleSeconds: 30,
  heapK: 50,
  allWidth: 1 << 16,
  categoryWidth: 1 << 14,
  depth: 4,
  categoryCap: 100,
  memoryBudgetMb: 512,
  retentionSeconds: 10_800,
  aggregateBudgetMs: 100,
  productBudgetMs: 100,
  shopBudgetMs: 50,
  mergeBudgetMs: 100,
  connectTimeoutMs: 5_000,
  shutdownDeadlineMs: 10_000,
  filterBits: 1 << 24,
  tickMs: 5_000,
  mergeBackoffBaseMs: 100,
};

/** Env name of each setting; the violation names it, never its value. */
export const TRENDING_ENV_NAMES: Record<keyof TrendingSettingsValues, string> =
  {
    weightView: 'TRENDING_WEIGHT_VIEW',
    weightCart: 'TRENDING_WEIGHT_CART',
    windowSeconds: 'TRENDING_WINDOW_SECONDS',
    latenessSeconds: 'TRENDING_LATENESS_SECONDS',
    idleSeconds: 'TRENDING_IDLE_SECONDS',
    heapK: 'TRENDING_HEAP_K',
    allWidth: 'TRENDING_ALL_WIDTH',
    categoryWidth: 'TRENDING_CATEGORY_WIDTH',
    depth: 'TRENDING_DEPTH',
    categoryCap: 'TRENDING_CATEGORY_CAP',
    memoryBudgetMb: 'TRENDING_MEMORY_BUDGET_MB',
    retentionSeconds: 'TRENDING_RETENTION_SECONDS',
    aggregateBudgetMs: 'TRENDING_AGGREGATE_BUDGET_MS',
    productBudgetMs: 'TRENDING_PRODUCT_BUDGET_MS',
    shopBudgetMs: 'TRENDING_SHOP_BUDGET_MS',
    mergeBudgetMs: 'TRENDING_MERGE_BUDGET_MS',
    connectTimeoutMs: 'TRENDING_CONNECT_TIMEOUT_MS',
    shutdownDeadlineMs: 'TRENDING_SHUTDOWN_DEADLINE_MS',
    filterBits: 'TRENDING_FILTER_BITS',
    tickMs: 'TRENDING_TICK_MS',
    mergeBackoffBaseMs: 'TRENDING_MERGE_BACKOFF_BASE_MS',
  };

/** The window an interaction stays visible: 60 one-minute windows (FR-004). */
export const HORIZON_SECONDS = 3_600;
export const MAX_RETENTION_SECONDS = 10_800;

export interface SettingViolation {
  key: string;
  message: string;
}

const isPowerOfTwo = (n: number) =>
  Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

export function validateTrendingSettings(
  v: TrendingSettingsValues,
): SettingViolation[] {
  const out: SettingViolation[] = [];
  const fail = (name: keyof TrendingSettingsValues, message: string) =>
    out.push({ key: TRENDING_ENV_NAMES[name], message });
  const intIn = (
    name: keyof TrendingSettingsValues,
    min: number,
    max = Number.MAX_SAFE_INTEGER,
  ) => {
    const x = v[name];
    if (!Number.isInteger(x) || x < min || x > max)
      fail(
        name,
        max === Number.MAX_SAFE_INTEGER
          ? `must be an integer of at least ${min}`
          : `must be an integer from ${min} to ${max}`,
      );
  };

  intIn('weightView', 1);
  intIn('weightCart', 1);
  if (v.windowSeconds !== 60)
    fail('windowSeconds', 'must be 60 in this version');
  intIn('latenessSeconds', 0, 600);
  intIn('idleSeconds', 1);
  intIn('heapK', 40);
  if (!isPowerOfTwo(v.allWidth)) fail('allWidth', 'must be a power of two');
  if (!isPowerOfTwo(v.categoryWidth))
    fail('categoryWidth', 'must be a power of two');
  intIn('depth', 1, 8);
  intIn('categoryCap', 1);
  intIn('memoryBudgetMb', 1);
  const minRetention = HORIZON_SECONDS + v.latenessSeconds + HORIZON_SECONDS;
  if (
    !Number.isInteger(v.retentionSeconds) ||
    v.retentionSeconds < minRetention ||
    v.retentionSeconds > MAX_RETENTION_SECONDS
  )
    fail(
      'retentionSeconds',
      `must be an integer from ${minRetention} (horizon + lateness + correction horizon) to ${MAX_RETENTION_SECONDS}`,
    );
  intIn('aggregateBudgetMs', 1);
  intIn('productBudgetMs', 1);
  intIn('shopBudgetMs', 1);
  intIn('mergeBudgetMs', 1);
  intIn('connectTimeoutMs', 1);
  intIn('shutdownDeadlineMs', 1);
  if (!isPowerOfTwo(v.filterBits) || v.filterBits < 1024)
    fail('filterBits', 'must be a power of two of at least 1024');
  intIn('tickMs', 1);
  intIn('mergeBackoffBaseMs', 1);
  return out;
}
