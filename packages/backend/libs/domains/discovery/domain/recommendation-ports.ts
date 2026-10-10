/**
 * Ports of the recommendations slice (S34 D-6, constitution I.2). `application/` depends on these; adapters in `infra/`
 * bind them through the tokens below. Nothing here imports Nest, Redis, ClickHouse or another domain.
 */

/** A neighbour list entry as the store holds it: nothing is trusted yet (`sanitiseEntries` checks it). */
export interface StoredEntry {
  member: string;
  score: number | null | undefined;
}

/** Read half of the precomputed neighbour lists (Redis sorted sets, best score first). */
export interface NeighbourListReader {
  /** The product's list, best first; an expired or absent list is `[]`. */
  read(productId: string): Promise<StoredEntry[]>;
  /** The lists of several products in one round trip; every requested id is a key of the result. */
  readMany(productIds: string[]): Promise<Map<string, StoredEntry[]>>;
}

export interface PublishedList {
  productId: string;
  /** Best first. */
  entries: { member: string; score: number }[];
}

/** Write half: atomic per-list replacement and the removal pass after a complete build. */
export interface NeighbourListWriter {
  /** Replaces each list atomically (readers never see a half-written list) and records the ids under `runId`. */
  publish(runId: string, lists: PublishedList[]): Promise<void>;
  /** Deletes the lists of products not published under `runId`; returns how many were removed. */
  removeUnpublished(runId: string): Promise<number>;
  /** Forgets the run's bookkeeping. */
  closeRun(runId: string): Promise<void>;
}

export interface BasketRow {
  orderId: string;
  buyerId: string;
  /** Distinct and sorted. */
  products: string[];
  paidAt: Date;
  orderVersion: number;
}

export interface EdgeRow {
  a: string;
  b: string;
  co: number;
  score: number;
}

export interface EdgeQuery {
  since: Date;
  buckets: number;
  bucket: number;
  minCoOrders: number;
  minBuyers: number;
  top: number;
}

/** The basket store (ClickHouse) as the capture service and the build see it. */
export interface BasketStore {
  /** Highest stored `order_version` per order id (absent orders are not keys). */
  storedVersions(orderIds: string[]): Promise<Map<string, number>>;
  insert(rows: BasketRow[]): Promise<void>;
  /** True when no eligible basket was paid at or after `since`. */
  isEmpty(since: Date): Promise<boolean>;
  /** The best `top` neighbours of every product of one bucket, ordered `a`, score desc, `b` asc. */
  edges(query: EdgeQuery): Promise<EdgeRow[]>;
}

/** Mutual exclusion of the nightly build across processes. */
export interface BuildLock {
  /** An owner token, or `null` when another run holds the lock. */
  acquire(): Promise<string | null>;
  release(token: string): Promise<void>;
}

/** What the read path needs to know about a product, from the catalog and tenancy entry points. */
export interface ProductFacts {
  title: string;
  priceMinor: number;
  currency: string;
  /** Product `ACTIVE`, not sandbox, and its shop `ACTIVE`: the product page exists. */
  listed: boolean;
  inStock: boolean;
}

export interface CatalogFacts {
  /** One product batch and one shop batch for the whole pool; unknown ids are absent. */
  lookup(productIds: string[]): Promise<Map<string, ProductFacts>>;
}

export interface RecommendationsClock {
  now(): Date;
}

export const NEIGHBOUR_LIST_READER = Symbol('NEIGHBOUR_LIST_READER');
export const NEIGHBOUR_LIST_WRITER = Symbol('NEIGHBOUR_LIST_WRITER');
export const BASKET_STORE = Symbol('BASKET_STORE');
export const BUILD_LOCK = Symbol('BUILD_LOCK');
export const CATALOG_FACTS = Symbol('CATALOG_FACTS');
export const RECOMMENDATIONS_CLOCK = Symbol('RECOMMENDATIONS_CLOCK');
