/**
 * The only place that builds trending key names (S35 AS-39, T34). Every key is computed, never scanned for, and every key
 * written gets a TTL. Categories are catalog slugs (`[a-z0-9-]`, validated before they get here).
 *
 * The aggregate of a category carries a hash tag of its category, so a union of its windows stays in one slot. The merge
 * script also touches the merge record and the aggregates of several categories: that is fine on the single-node client in
 * use; a Redis Cluster would need a hash tag per window (research R-3).
 */
export const aggregateKey = (category: string, windowStartMs: number) =>
  `trending:{${category}}:${windowStartMs}`;

export const mergeKey = (partition: number, windowStartMs: number) =>
  `trending:merge:${partition}:${windowStartMs}`;

export const correctionMergeKey = (
  partition: number,
  windowStartMs: number,
  firstOffset: number,
  lastOffset: number,
) =>
  `trending:merge:${partition}:${windowStartMs}:c:${firstOffset}-${lastOffset}`;

export const seenKey = (eventId: string) => `trending:seen:${eventId}`;

/** Defined next to the pure ranking (the application layer needs it); named here with every other key. */
export { rankCacheKey } from '../domain/trending-ranking';
