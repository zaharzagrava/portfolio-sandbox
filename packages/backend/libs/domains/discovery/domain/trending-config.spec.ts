import {
  TRENDING_DEFAULTS,
  validateTrendingSettings,
  type TrendingSettingsValues,
} from './trending-config';

const with_ = (patch: Partial<TrendingSettingsValues>) => ({
  ...TRENDING_DEFAULTS,
  ...patch,
});

describe('S35 AS-37: trending settings validation', () => {
  it('S35 AS-37: the defaults are the documented ones and are valid', () => {
    expect(TRENDING_DEFAULTS).toMatchObject({
      weightView: 1,
      weightCart: 5,
      windowSeconds: 60,
      latenessSeconds: 120,
      idleSeconds: 30,
      heapK: 50,
      allWidth: 65536,
      categoryWidth: 16384,
      depth: 4,
      categoryCap: 100,
      memoryBudgetMb: 512,
      retentionSeconds: 10800,
      aggregateBudgetMs: 100,
      productBudgetMs: 100,
      shopBudgetMs: 50,
      mergeBudgetMs: 100,
    });
    expect(validateTrendingSettings(TRENDING_DEFAULTS)).toEqual([]);
  });

  it.each<[string, Partial<TrendingSettingsValues>, string]>([
    ['weight 0', { weightView: 0 }, 'TRENDING_WEIGHT_VIEW'],
    ['weight not an integer', { weightCart: 2.5 }, 'TRENDING_WEIGHT_CART'],
    ['window not 60', { windowSeconds: 30 }, 'TRENDING_WINDOW_SECONDS'],
    ['negative lateness', { latenessSeconds: -1 }, 'TRENDING_LATENESS_SECONDS'],
    [
      'lateness above 10 min',
      { latenessSeconds: 601 },
      'TRENDING_LATENESS_SECONDS',
    ],
    ['idle below 1', { idleSeconds: 0 }, 'TRENDING_IDLE_SECONDS'],
    ['negative idle', { idleSeconds: -5 }, 'TRENDING_IDLE_SECONDS'],
    ['heap below 40', { heapK: 39 }, 'TRENDING_HEAP_K'],
    ['all width not a power of two', { allWidth: 60000 }, 'TRENDING_ALL_WIDTH'],
    [
      'category width not a power of two',
      { categoryWidth: 1000 },
      'TRENDING_CATEGORY_WIDTH',
    ],
    ['depth 0', { depth: 0 }, 'TRENDING_DEPTH'],
    ['depth 9', { depth: 9 }, 'TRENDING_DEPTH'],
    ['category cap 0', { categoryCap: 0 }, 'TRENDING_CATEGORY_CAP'],
    ['memory budget 0', { memoryBudgetMb: 0 }, 'TRENDING_MEMORY_BUDGET_MB'],
    [
      'retention below the horizon',
      { retentionSeconds: 3600 },
      'TRENDING_RETENTION_SECONDS',
    ],
    [
      'retention above 3 h',
      { retentionSeconds: 10801 },
      'TRENDING_RETENTION_SECONDS',
    ],
    [
      'aggregate budget 0',
      { aggregateBudgetMs: 0 },
      'TRENDING_AGGREGATE_BUDGET_MS',
    ],
    ['product budget 0', { productBudgetMs: 0 }, 'TRENDING_PRODUCT_BUDGET_MS'],
    ['shop budget 0', { shopBudgetMs: 0 }, 'TRENDING_SHOP_BUDGET_MS'],
    ['merge budget 0', { mergeBudgetMs: 0 }, 'TRENDING_MERGE_BUDGET_MS'],
    [
      'filter bits not a power of two',
      { filterBits: 1000 },
      'TRENDING_FILTER_BITS',
    ],
  ])('S35 AS-37: %s fails naming the setting', (_name, patch, key) => {
    const violations = validateTrendingSettings(with_(patch));
    expect(violations.map((v) => v.key)).toContain(key);
    expect(violations.find((v) => v.key === key)!.message).not.toEqual('');
  });

  it('S35 AS-37: retention must cover the horizon plus lateness plus the correction horizon', () => {
    const lateness = 600;
    const min = 3600 + lateness + 3600;
    expect(
      validateTrendingSettings(
        with_({ latenessSeconds: lateness, retentionSeconds: min - 1 }),
      ).map((v) => v.key),
    ).toContain('TRENDING_RETENTION_SECONDS');
    expect(
      validateTrendingSettings(
        with_({ latenessSeconds: lateness, retentionSeconds: min }),
      ),
    ).toEqual([]);
  });
});
