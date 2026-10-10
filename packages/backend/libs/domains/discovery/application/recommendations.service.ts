import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  RECOMMENDATION_LIMITS,
  recommendationsQuerySchema,
  type RecommendationsResponse,
} from '@marketplace-sandbox/contracts';
import { roundScore } from '../domain/cosine-score';
import {
  sanitiseEntries,
  type NeighbourEntry,
} from '../domain/neighbour-entry';
import {
  CATALOG_FACTS,
  NEIGHBOUR_LIST_READER,
  type CatalogFacts,
  type NeighbourListReader,
} from '../domain/recommendation-ports';
import {
  RecommendationsProductNotFoundError,
  RecommendationsUnavailableError,
  RecommendationsValidationError,
} from '../domain/recommendation-errors';
import { rankCandidates } from '../domain/recommendation-ranking';
import { blendTwoHop } from '../domain/two-hop-blend';
import {
  recommendationsBadEntries,
  recommendationsHops,
  recommendationsRequests,
} from '../infra/recommendations-metrics';
import { RecommendationsSettings } from '../infra/recommendations-config';

/** Runs one dependency call; a failure or overrun becomes the one 503 and only the error name is logged. */
async function guarded<T>(logger: Logger, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    recommendationsRequests.add(1, { result: 'unavailable' });
    logger.warn(
      `dependency failed: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    throw new RecommendationsUnavailableError();
  }
}

const productIdSchema = z.string().uuid();

/** Best score first, equal scores by id: the order seeds are picked in. */
const bestFirst = (a: NeighbourEntry, b: NeighbourEntry): number =>
  b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Read path of "bought together" (S34 FR-001 to FR-012). One read of the product's list; when it does not fill the rail, a
 * depth-2 expansion over the top seeds in one batched read of their full lists; then one product batch and one shop batch
 * for the whole pool, so visibility is decided on every request. Pure ranking decides the order.
 */
@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    @Inject(NEIGHBOUR_LIST_READER) private readonly lists: NeighbourListReader,
    @Inject(CATALOG_FACTS) private readonly catalog: CatalogFacts,
    private readonly settings: RecommendationsSettings,
  ) {}

  async boughtTogether(
    rawProductId: string,
    rawQuery: Record<string, unknown>,
  ): Promise<RecommendationsResponse> {
    const { productId, limit } = this.validate(rawProductId, rawQuery);

    const stored = sanitiseEntries(
      productId,
      await guarded(this.logger, () => this.lists.read(productId)),
    );
    let bad = stored.skipped;
    const direct = [...stored.entries].sort(bestFirst);

    // Fewer valid direct neighbours than the rail asked for: borrow from the neighbours of the best ones (R-2).
    let seeds: { seed: NeighbourEntry; list: NeighbourEntry[] }[] = [];
    if (direct.length > 0 && direct.length < limit) {
      const chosen = direct.slice(0, this.settings.expandSeeds);
      const read = await guarded(this.logger, () =>
        this.lists.readMany(chosen.map((s) => s.id)),
      );
      seeds = chosen.map((seed) => {
        const clean = sanitiseEntries(productId, read.get(seed.id) ?? []);
        bad += clean.skipped;
        return { seed, list: clean.entries };
      });
    }
    if (bad > 0) recommendationsBadEntries.add(bad);

    const pool = blendTwoHop(productId, direct, seeds, this.settings.hopDecay);
    const facts = await guarded(this.logger, () =>
      this.catalog.lookup([productId, ...pool.map((c) => c.productId)]),
    );
    if (!facts.get(productId)?.listed) {
      recommendationsRequests.add(1, { result: 'not_found' });
      throw new RecommendationsProductNotFoundError();
    }

    const ranked = rankCandidates(
      pool.filter((c) => {
        const f = facts.get(c.productId);
        return !!f && f.listed && f.inStock;
      }),
      limit,
    );
    for (const hops of [1, 2] as const) {
      const n = ranked.filter((c) => c.hops === hops).length;
      if (n > 0) recommendationsHops.add(n, { hops: String(hops) });
    }
    recommendationsRequests.add(1, {
      result: ranked.length === 0 ? 'empty' : 'ok',
    });
    return {
      type: 'bought-together',
      items: ranked.map((c) => {
        const f = facts.get(c.productId)!;
        return {
          productId: c.productId,
          title: f.title,
          priceMinor: f.priceMinor,
          currency: f.currency,
          score: roundScore(c.score),
          hops: c.hops,
        };
      }),
    };
  }

  private validate(
    rawProductId: string,
    rawQuery: Record<string, unknown>,
  ): { productId: string; limit: number } {
    const fields: string[] = [];
    if (!productIdSchema.safeParse(rawProductId).success)
      fields.push('productId');
    const parsed = recommendationsQuerySchema.safeParse(rawQuery);
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        if (issue.code === 'unrecognized_keys') fields.push(...issue.keys);
        else
          fields.push(issue.path.length > 0 ? String(issue.path[0]) : 'query');
      }
    if (fields.length > 0) {
      recommendationsRequests.add(1, { result: 'invalid' });
      throw new RecommendationsValidationError([...new Set(fields)]);
    }
    return {
      productId: rawProductId.toLowerCase(),
      limit: parsed.success
        ? (parsed.data.limit ?? RECOMMENDATION_LIMITS.limit.default)
        : RECOMMENDATION_LIMITS.limit.default,
    };
  }
}
