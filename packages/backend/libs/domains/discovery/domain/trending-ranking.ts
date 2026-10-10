import type { RankedEntry, TrendingProductFacts } from './trending-ports';

const WINDOW_MS = 60_000;
export const SERVING_WINDOWS = 60;
export const MAX_POOL = 60;

/**
 * The 60 one-minute windows ending at the latest minute boundary (S35 FR-004, research R-9): starts from `boundary - 60
 * min` to `boundary - 1 min`, oldest first. The still-open current minute is excluded.
 */
export function servingWindows(nowMs: number): number[] {
  const boundary = nowMs - (nowMs % WINDOW_MS);
  return Array.from(
    { length: SERVING_WINDOWS },
    (_, i) => boundary - (SERVING_WINDOWS - i) * WINDOW_MS,
  );
}

/** The latest minute boundary at `nowMs`; part of the ranking cache key. */
export const boundaryOf = (nowMs: number): number =>
  nowMs - (nowMs % WINDOW_MS);

/**
 * Cache key of one ranking: the boundary is part of it, so a new minute never serves the previous minute's set. It has the
 * shape the cache toolkit's `cacheKey('trending', 1, 'rank', category, boundary)` builds (the category is a validated slug,
 * so nothing needs encoding); `infra/trending-keys.ts` re-exports it as the one place that names keys.
 */
export const rankCacheKey = (category: string, boundaryMs: number): string =>
  `trending:v1:rank:${category}:${boundaryMs}`;

/** Candidate pool: enough to replace hidden items while keeping both lookups far below their id limit. */
export const poolSize = (limit: number): number =>
  Math.min(3 * limit, MAX_POOL);

/** Sums duplicates, then orders by score descending and equal scores by `productId` ascending by code unit (FR-004). */
export function sumAndOrder(entries: readonly RankedEntry[]): RankedEntry[] {
  const sums = new Map<string, number>();
  for (const e of entries)
    sums.set(e.productId, (sums.get(e.productId) ?? 0) + e.score);
  return [...sums]
    .map(([productId, score]) => ({ productId, score }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
    );
}

export interface VisibleItem {
  rank: number;
  productId: string;
  title: string;
  priceMinor: number;
  currency: string;
  category: string;
  score: number;
}

/**
 * Visibility (FR-006): a candidate is shown only when its product is ACTIVE, not a sandbox product, in stock, its shop is
 * ACTIVE and, for a category other than `all`, its catalog category equals the requested one. Unknown ids are dropped,
 * the list is not padded, ranks are assigned after filtering.
 */
export function selectVisible(
  pool: readonly RankedEntry[],
  facts: ReadonlyMap<string, TrendingProductFacts>,
  category: string,
  limit: number,
): VisibleItem[] {
  const items: VisibleItem[] = [];
  for (const candidate of pool) {
    if (items.length >= limit) break;
    const f = facts.get(candidate.productId);
    if (!f) continue;
    if (f.status !== 'ACTIVE' || f.isSandbox || !f.inStock) continue;
    if (f.shopStatus !== 'ACTIVE') continue;
    if (category !== 'all' && f.category !== category) continue;
    items.push({
      rank: items.length + 1,
      productId: candidate.productId,
      title: f.title,
      priceMinor: f.priceMinor,
      currency: f.currency,
      category: f.category,
      score: candidate.score,
    });
  }
  return items;
}
