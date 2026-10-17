import { Inject, Injectable } from '@nestjs/common';
import type {
  CompetitorPrices,
  CompetitorWatch,
  CompetitorWatchList,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { SafeRequestError } from '@app/infrastructure/net';
import {
  ProductArchivedError,
  ProductNotFoundError,
  ProductQueryService,
  type ProductDto,
} from '@app/domains/catalog';
import { EntitlementsService } from '@app/domains/billing';
import { UrlRefused, normalizeUrl } from '../domain/url';
import {
  competitorValidationFailed,
  historyUnavailable,
  ObservationHistoryUnavailable,
  urlNotAllowed,
  urlUnresolvable,
  watchLimitReached,
  watchNotFound,
} from '../domain/competitor-errors';
import {
  OBSERVATION_HISTORY,
  SAFE_FETCHER,
  SEEN_SET,
  TARGET_REPOSITORY,
  WATCH_REPOSITORY,
  type ObservationHistory,
  type SafeFetcher,
  type SeenSet,
  type TargetRepository,
  type WatchCursor,
  type WatchRepository,
  type WatchView,
} from '../domain/crawler-ports';
import { COMPETITOR_FRESHNESS_MS } from './crawl.constants';
import { CompetitorEvaluationService } from './competitor-evaluation.service';
import { crawlerMetrics } from './crawler.metrics';

/** Watches of one product, whatever the shop's limit (S41 FR-003). */
export const MAX_WATCHES_PER_PRODUCT = 5;
const PRICE_POINTS_MAX = 1000;
const DAY_MS = 86_400_000;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toWatchDto(view: WatchView): CompetitorWatch {
  return {
    id: view.id,
    productId: view.productId,
    url: view.url,
    host: view.host,
    status: view.status,
    lastPriceMinor: view.targetPriceMinor,
    currency: view.targetCurrency,
    lastCheckedAt: iso(view.targetLastCheckedAt),
    lastStatus: view.targetLastStatus,
    nextCheckAt: view.targetNextCheckAt.toISOString(),
    createdAt: view.createdAt.toISOString(),
  };
}

const encodeCursor = (c: WatchCursor) =>
  Buffer.from(JSON.stringify([c.createdAt, c.id])).toString('base64url');

function decodeCursor(raw: string): WatchCursor {
  try {
    const [createdAt, id] = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as [string, string];
    if (
      typeof createdAt !== 'string' ||
      Number.isNaN(Date.parse(createdAt)) ||
      !/^[0-9a-f-]{36}$/i.test(id)
    )
      throw new Error('bad cursor');
    return { createdAt, id };
  } catch {
    throw competitorValidationFailed(['cursor']);
  }
}

/** Registers, lists, removes and reads the history of a shop's competitor watches (S41 US1, US2). */
@Injectable()
export class CompetitorWatchService {
  constructor(
    @Inject(WATCH_REPOSITORY) private readonly watches: WatchRepository,
    @Inject(TARGET_REPOSITORY) private readonly targets: TargetRepository,
    @Inject(SEEN_SET) private readonly seen: SeenSet,
    @Inject(SAFE_FETCHER) private readonly fetcher: SafeFetcher,
    @Inject(OBSERVATION_HISTORY) private readonly history: ObservationHistory,
    private readonly products: ProductQueryService,
    private readonly entitlements: EntitlementsService,
    private readonly evaluation: CompetitorEvaluationService,
    private readonly transactions: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * `created: false` is an idempotent replay (`200`). Nothing is fetched from the competitor: the URL is normalised and
   * checked by the SSRF guard, the product is the shop's, the limits hold under a per-shop lock, and a target seen
   * within the hour is not made due again.
   */
  async register(
    shopId: string,
    input: { productId: string; url: string },
  ): Promise<{ created: boolean; watch: CompetitorWatch }> {
    const url = this.normalise(input.url);
    await this.guard(url);
    const product = await this.ownProduct(shopId, input.productId);

    const known = await this.seen.contains(url);
    const existing = await this.targets.findByUrl(url);
    if (existing) {
      const replay = await this.watches.findByProductAndTarget(
        shopId,
        input.productId,
        existing.id,
      );
      if (replay) {
        crawlerMetrics.seenSet(known ? 'confirmed_hit' : 'definitely_new');
        // a lost seen-set refills as URLs are met again
        if (!known) await this.seen.add(url).catch(() => undefined);
        return { created: false, watch: toWatchDto(replay) };
      }
    }
    crawlerMetrics.seenSet(
      !known ? 'definitely_new' : existing ? 'confirmed_hit' : 'false_positive',
    );

    const current = await this.watches.countByShop(shopId);
    const { limit } = await this.entitlements.checkLimit(
      'SHOP',
      shopId,
      'maxCompetitorWatches',
      current,
    );
    const observed = existing !== null && existing.observationNo > 0;
    const context = observed
      ? await this.evaluation.prefetch(
          [{ shopId, productId: input.productId }],
          {
            products: new Map([[product.id, product]]),
          },
        )
      : null;

    const result = await this.transactions.run(async () => {
      await this.watches.lockShop(shopId);
      const now = this.clock.now();
      const host = new URL(url).host;
      const target = await this.targets.upsertByUrl(url, host, now);
      const replay = await this.watches.findByProductAndTarget(
        shopId,
        input.productId,
        target.id,
      );
      if (replay) return { created: false, view: replay };
      if (
        (await this.watches.countByProduct(shopId, input.productId)) >=
        MAX_WATCHES_PER_PRODUCT
      )
        throw watchLimitReached('product', MAX_WATCHES_PER_PRODUCT);
      if ((await this.watches.countByShop(shopId)) >= limit)
        throw watchLimitReached('shop', limit);
      const watch = await this.watches.insertIfAbsent({
        shopId,
        productId: input.productId,
        targetId: target.id,
        now,
      });
      if (!watch) {
        const raced = await this.watches.findByProductAndTarget(
          shopId,
          input.productId,
          target.id,
        );
        return { created: false, view: raced! };
      }
      if (target.retiredAt) await this.targets.revive(target.id);
      await this.targets.pullForward(target.id, now, COMPETITOR_FRESHNESS_MS);
      if (context && target.observationNo > 0 && target.lastPriceMinor !== null)
        await this.evaluation.evaluateBatch(
          context,
          {
            id: target.id,
            host: target.host,
            observationNo: target.observationNo,
            priceMinor: target.lastPriceMinor,
            currency: target.currency!,
          },
          [watch],
        );
      const view = await this.watches.findView(shopId, watch.id);
      return { created: true, view: view! };
    });
    await this.seen.add(url).catch(() => undefined);
    return { created: result.created, watch: toWatchDto(result.view) };
  }

  async list(
    shopId: string,
    query: { productId?: string; limit: number; cursor?: string },
  ): Promise<CompetitorWatchList> {
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.watches.list(shopId, {
      productId: query.productId,
      limit: query.limit + 1,
      after,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toWatchDto),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  async remove(shopId: string, watchId: string): Promise<void> {
    await this.transactions.run(async () => {
      const targetId = await this.watches.deleteForShop(shopId, watchId);
      if (targetId === null) throw watchNotFound();
      await this.targets.retireUnwatched([targetId], this.clock.now());
    });
  }

  async prices(
    shopId: string,
    watchId: string,
    days: number,
  ): Promise<CompetitorPrices> {
    const view = await this.watches.findView(shopId, watchId);
    if (!view) throw watchNotFound();
    const to = this.clock.now();
    const from = new Date(to.getTime() - days * DAY_MS);
    let rows;
    try {
      rows = await this.history.read(view.targetId, from, to, PRICE_POINTS_MAX);
    } catch (error) {
      if (error instanceof ObservationHistoryUnavailable)
        throw historyUnavailable();
      throw error;
    }
    const currency = rows.length > 0 ? rows[rows.length - 1].currency : null;
    const points = rows.filter((r) => r.currency === currency);
    let lowest = null as (typeof points)[number] | null;
    for (const p of points)
      if (lowest === null || p.priceMinor < lowest.priceMinor) lowest = p;
    return {
      watchId,
      currency,
      from: from.toISOString(),
      to: to.toISOString(),
      points: points.map((p) => ({
        observedAt: p.observedAt.toISOString(),
        priceMinor: p.priceMinor,
      })),
      lowestMinor: lowest?.priceMinor ?? null,
      lowestAt: lowest ? lowest.observedAt.toISOString() : null,
      latestMinor: points.length ? points[points.length - 1].priceMinor : null,
    };
  }

  private normalise(raw: string): string {
    try {
      return normalizeUrl(raw);
    } catch (error) {
      if (error instanceof UrlRefused)
        throw error.reason === 'port'
          ? urlNotAllowed()
          : competitorValidationFailed(['url']);
      throw error;
    }
  }

  private async guard(url: string): Promise<void> {
    try {
      await this.fetcher.check(url);
    } catch (error) {
      if (!(error instanceof SafeRequestError)) throw error;
      throw error.kind === 'invalid_url' || error.kind === 'blocked_address'
        ? urlNotAllowed()
        : urlUnresolvable();
    }
  }

  private async ownProduct(
    shopId: string,
    productId: string,
  ): Promise<ProductDto> {
    const found = await this.products.getProductsByIds([productId], {
      shopId,
    });
    const product = found.get(productId.toLowerCase());
    if (!product) throw new ProductNotFoundError();
    if (product.status !== 'ACTIVE') throw new ProductArchivedError();
    return product;
  }
}
