import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  trendingQuerySchema,
  type TrendingResponse,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import type { TrendingSettingsValues } from '../domain/trending-config';
import {
  TrendingDependencyError,
  TrendingUnavailableError,
  TrendingValidationError,
  type TrendingDependency,
} from '../domain/trending-errors';
import {
  TRENDING_AGGREGATE_READER,
  TRENDING_CATALOG_FACTS,
  TRENDING_SETTINGS,
  type RankedEntry,
  type TrendingAggregateReader,
  type TrendingCatalogFacts,
} from '../domain/trending-ports';
import {
  boundaryOf,
  MAX_POOL,
  poolSize,
  rankCacheKey,
  selectVisible,
  servingWindows,
  sumAndOrder,
} from '../domain/trending-ranking';
import {
  trendingDependencyFailures,
  trendingRankingCache,
  trendingRequests,
} from './trending-metrics';

const RANKING_TTL_MS = 30_000;

/**
 * "Trending in the last hour" (S35 FR-001 to FR-010). The ranking (60 closed windows summed, best 60) is cached for 30
 * seconds with one computation shared by concurrent readers; the facts and visibility of the candidate pool are looked up
 * on EVERY origin request in one product batch and one shop batch, so a stock, status or price change shows at once. Any
 * dependency failure is the one `503`, never an unfiltered list, never retried inside the request.
 */
@Injectable()
export class TrendingService {
  private readonly logger = new Logger(TrendingService.name);

  constructor(
    @Inject(TRENDING_AGGREGATE_READER)
    private readonly aggregates: TrendingAggregateReader,
    @Inject(TRENDING_CATALOG_FACTS)
    private readonly catalog: TrendingCatalogFacts,
    @Inject(TRENDING_SETTINGS)
    private readonly settings: TrendingSettingsValues,
    private readonly cache: CacheService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async trending(rawQuery: Record<string, unknown>): Promise<TrendingResponse> {
    const { category, limit } = this.validate(rawQuery);
    const now = this.clock.now();
    const ranking = await this.ranking(category, now.getTime());
    const pool = ranking.slice(0, poolSize(limit));
    let items: TrendingResponse['items'] = [];
    if (pool.length > 0) {
      const facts = await this.guarded('product', () =>
        this.catalog.lookup(pool.map((e) => e.productId)),
      );
      items = selectVisible(pool, facts, category, limit);
    }
    trendingRequests.add(1, { outcome: items.length === 0 ? 'empty' : 'ok' });
    return {
      category,
      windowMinutes: 60,
      generatedAt: now.toISOString(),
      items,
    };
  }

  private async ranking(
    category: string,
    nowMs: number,
  ): Promise<RankedEntry[]> {
    let loaded = false;
    const stored = await this.guarded('cache', () =>
      this.cache.getOrLoad<RankedEntry[]>(
        rankCacheKey(category, boundaryOf(nowMs)),
        async () => {
          loaded = true;
          try {
            return sumAndOrder(
              await this.aggregates.readUnion(
                category,
                servingWindows(nowMs),
                MAX_POOL,
              ),
            );
          } catch (cause) {
            throw new TrendingDependencyError('aggregate', cause);
          }
        },
        { ttlMs: RANKING_TTL_MS, l1: 'never' },
      ),
    );
    trendingRankingCache.add(1, { result: loaded ? 'miss' : 'hit' });
    return stored ?? [];
  }

  /** Runs one dependency call; a failure or overrun becomes the one 503 and only the error name is logged. */
  private async guarded<T>(
    fallback: TrendingDependency,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const dependency =
        error instanceof TrendingDependencyError ? error.dependency : fallback;
      trendingDependencyFailures.add(1, { dependency });
      trendingRequests.add(1, { outcome: 'unavailable' });
      this.logger.warn(
        `dependency failed: ${dependency} (${error instanceof Error ? error.name : 'unknown'})`,
      );
      throw new TrendingUnavailableError();
    }
  }

  private validate(rawQuery: Record<string, unknown>): {
    category: string;
    limit: number;
  } {
    const parsed = trendingQuerySchema.safeParse(rawQuery);
    if (parsed.success) return parsed.data;
    const fields: string[] = [];
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys') fields.push(...issue.keys);
      else fields.push(issue.path.length > 0 ? String(issue.path[0]) : 'query');
    }
    trendingRequests.add(1, { outcome: 'invalid' });
    throw new TrendingValidationError([...new Set(fields)]);
  }
}
