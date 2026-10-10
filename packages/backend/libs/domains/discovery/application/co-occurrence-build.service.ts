import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BuildParams } from '../domain/build-params';
import {
  BASKET_STORE,
  BUILD_LOCK,
  NEIGHBOUR_LIST_WRITER,
  RECOMMENDATIONS_CLOCK,
  type BasketStore,
  type BuildLock,
  type EdgeRow,
  type NeighbourListWriter,
  type PublishedList,
  type RecommendationsClock,
} from '../domain/recommendation-ports';
import {
  recommendationsBuildDuration,
  recommendationsBuildEdges,
  recommendationsBuildLastSuccess,
  recommendationsBuildProducts,
  recommendationsBuildSkipped,
} from '../infra/recommendations-metrics';
import { RecommendationsSettings } from '../infra/recommendations-config';

const DAY_MS = 86_400_000;

export interface BuildOutcome {
  outcome: 'completed' | 'skipped_empty' | 'skipped_locked';
  products: number;
  edges: number;
  removed: number;
}

const nothing = (outcome: BuildOutcome['outcome']): BuildOutcome => ({
  outcome,
  products: 0,
  edges: 0,
  removed: 0,
});

/**
 * Nightly build use case (S34 FR-016 to FR-026): lock, empty-source guard, bucketed counting, per-list atomic publish, and
 * only after every bucket succeeded the removal of lists that lost all their edges. A failure at any point leaves every
 * list complete and deletes nothing; the success timestamp moves only on `completed`.
 */
@Injectable()
export class CoOccurrenceBuildService {
  private readonly logger = new Logger(CoOccurrenceBuildService.name);

  constructor(
    @Inject(BASKET_STORE) private readonly baskets: BasketStore,
    @Inject(NEIGHBOUR_LIST_WRITER) private readonly lists: NeighbourListWriter,
    @Inject(BUILD_LOCK) private readonly lock: BuildLock,
    @Inject(RECOMMENDATIONS_CLOCK) private readonly clock: RecommendationsClock,
    private readonly settings: RecommendationsSettings,
  ) {}

  get defaults(): BuildParams {
    return { days: this.settings.windowDays, buckets: this.settings.buckets };
  }

  async build(
    params: BuildParams,
    signal?: AbortSignal,
  ): Promise<BuildOutcome> {
    const token = await this.lock.acquire();
    if (!token) {
      recommendationsBuildSkipped.add(1, { reason: 'locked' });
      this.logger.warn({
        action: 'recommendations.build.skipped',
        reason: 'locked',
      });
      return nothing('skipped_locked');
    }
    const runId = randomUUID();
    const started = this.clock.now();
    try {
      const since = new Date(started.getTime() - params.days * DAY_MS);
      if (await this.baskets.isEmpty(since)) {
        recommendationsBuildSkipped.add(1, { reason: 'empty' });
        this.logger.warn({
          action: 'recommendations.build.skipped',
          reason: 'empty',
        });
        return nothing('skipped_empty');
      }

      let products = 0;
      let edges = 0;
      for (let bucket = 0; bucket < params.buckets; bucket++) {
        if (signal?.aborted) throw new Error('build aborted');
        const rows = await this.baskets.edges({
          since,
          buckets: params.buckets,
          bucket,
          minCoOrders: this.settings.minCoOrders,
          minBuyers: this.settings.minBuyers,
          top: this.settings.topN,
        });
        const lists = groupByProduct(rows);
        await this.lists.publish(runId, lists);
        products += lists.length;
        edges += rows.length;
      }

      const removed = await this.lists.removeUnpublished(runId);
      const finished = this.clock.now();
      recommendationsBuildDuration.record(
        (finished.getTime() - started.getTime()) / 1000,
      );
      recommendationsBuildProducts.set(products);
      recommendationsBuildEdges.set(edges);
      recommendationsBuildLastSuccess.set(
        Math.floor(finished.getTime() / 1000),
      );
      this.logger.log({
        action: 'recommendations.build.completed',
        products,
        edges,
        removed,
      });
      return { outcome: 'completed', products, edges, removed };
    } finally {
      await this.lists.closeRun(runId).catch(() => undefined);
      await this.lock.release(token).catch(() => undefined);
    }
  }
}

/** `rows` arrive ordered by product then best score; one list per product, best first. */
function groupByProduct(rows: EdgeRow[]): PublishedList[] {
  const byProduct = new Map<string, PublishedList>();
  for (const row of rows) {
    let list = byProduct.get(row.a);
    if (!list) byProduct.set(row.a, (list = { productId: row.a, entries: [] }));
    list.entries.push({ member: row.b, score: row.score });
  }
  return [...byProduct.values()];
}
