/**
 * Ports of the trending slice (S35 D-6, constitution I.2). `application/` depends on these; adapters in `infra/` bind them
 * through the tokens below. Nothing here imports Nest, Redis, Kafka or another domain.
 */

/** One entry of a ranking: a product and its summed weighted count. */
export interface RankedEntry {
  productId: string;
  score: number;
}

/** Read half of the window aggregates. Throws when the store fails or answers too late; an empty store is `[]`. */
export interface TrendingAggregateReader {
  /** Sum of the given windows for `category`, best score first (ties are the caller's business), at most `limit` entries. */
  readUnion(
    category: string,
    windowStartsMs: number[],
    limit: number,
  ): Promise<RankedEntry[]>;
}

/** A closed window of one partition: its partition-level top-K per category (`all` included), added to the aggregates. */
export interface WindowMerge {
  partition: number;
  windowStartMs: number;
  firstOffset: number;
  lastOffset: number;
  categories: { category: string; entries: RankedEntry[] }[];
}

/** One late event applied through the correction path: counted once per `eventId`, however often it is delivered. */
export interface CorrectionEvent {
  eventId: string;
  productId: string;
  weight: number;
  /** The categories it counts in, `all` included. */
  categories: string[];
}

export interface CorrectionMerge {
  windowStartMs: number;
  events: CorrectionEvent[];
}

export type MergeOutcome = 'applied' | 'replayed';

/**
 * Write half. Every call is atomic (all or nothing) and idempotent, and throws on failure:
 * - `mergeWindow`: identified by (partition, window); a second call for the same pair changes nothing (`replayed`);
 * - `mergeCorrections`: each event is claimed by its id inside the same atomic step, so an event counts once however often
 *   it is redelivered; `applied` is how many events were new.
 */
export interface TrendingAggregateWriter {
  mergeWindow(merge: WindowMerge): Promise<MergeOutcome>;
  mergeCorrections(merge: CorrectionMerge): Promise<{ applied: number }>;
}

export interface TrendingProductFacts {
  title: string;
  priceMinor: number;
  currency: string;
  /** The catalog category: the authority over the category an event claimed. */
  category: string;
  status: string;
  isSandbox: boolean;
  inStock: boolean;
  /** `null` when the shop is unknown. */
  shopStatus: string | null;
}

/** Catalog and shop facts of a pool of candidates, in batches. Unknown ids are absent. Throws on failure or timeout. */
export interface TrendingCatalogFacts {
  lookup(productIds: string[]): Promise<Map<string, TrendingProductFacts>>;
}

/** Injection token of the validated settings (`TrendingSettingsValues`); infra binds the class that reads the configuration. */
export const TRENDING_SETTINGS = Symbol('TRENDING_SETTINGS');
export const TRENDING_AGGREGATE_READER = Symbol('TRENDING_AGGREGATE_READER');
export const TRENDING_AGGREGATE_WRITER = Symbol('TRENDING_AGGREGATE_WRITER');
export const TRENDING_CATALOG_FACTS = Symbol('TRENDING_CATALOG_FACTS');
