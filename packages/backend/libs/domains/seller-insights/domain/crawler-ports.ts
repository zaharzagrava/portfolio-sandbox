import type { RobotsRules } from './robots';
import type { CrawlStatus } from './schedule';

/**
 * Ports of the competitor monitor (S41 gaps A31, constitution I.2): the application layer reaches Postgres, Redis,
 * ClickHouse, object storage and the network only through these. Adapters live in `infra/`.
 */

export type WatchStatus = 'ACTIVE' | 'PAUSED';

export interface TargetRecord {
  id: string;
  url: string;
  host: string;
  lastPriceMinor: number | null;
  currency: string | null;
  simhash: string | null;
  unchangedStreak: number;
  noPriceStreak: number;
  errorStreak: number;
  lastStatus: string | null;
  lastCheckedAt: Date | null;
  nextCheckAt: Date;
  observationNo: number;
  evaluatedNo: number;
  retiredAt: Date | null;
}

export interface WatchRecord {
  id: string;
  shopId: string;
  productId: string;
  targetId: string;
  status: WatchStatus;
  createdAt: Date;
  lastEvaluatedObservationNo: number;
  lastEvaluatedPriceMinor: number | null;
}

/** A watch with the part of its target a seller may see. */
export interface WatchView extends WatchRecord {
  url: string;
  host: string;
  targetPriceMinor: number | null;
  targetCurrency: string | null;
  targetLastCheckedAt: Date | null;
  targetLastStatus: string | null;
  targetNextCheckAt: Date;
  targetObservationNo: number;
}

export interface WatchCursor {
  createdAt: string;
  id: string;
}

export const WATCH_REPOSITORY = Symbol('S41_WATCH_REPOSITORY');
export interface WatchRepository {
  /** Serialises registrations of one shop for the rest of the active transaction. */
  lockShop(shopId: string): Promise<void>;
  countByShop(shopId: string): Promise<number>;
  countByProduct(shopId: string, productId: string): Promise<number>;
  findByProductAndTarget(
    shopId: string,
    productId: string,
    targetId: string,
  ): Promise<WatchView | null>;
  /** `null` when the (product, target) pair already has a watch. */
  insertIfAbsent(input: {
    shopId: string;
    productId: string;
    targetId: string;
    now: Date;
  }): Promise<WatchRecord | null>;
  findView(shopId: string, watchId: string): Promise<WatchView | null>;
  list(
    shopId: string,
    options: { productId?: string; limit: number; after?: WatchCursor },
  ): Promise<WatchView[]>;
  /** The target of the removed watch, or `null` when the shop has no such watch. */
  deleteForShop(shopId: string, watchId: string): Promise<string | null>;
  deleteByProduct(productId: string): Promise<string[]>;
  deleteByShop(shopId: string): Promise<string[]>;
  setStatusForShop(shopId: string, status: WatchStatus): Promise<number>;
  /** Active watches of the target not yet evaluated for observation `no`, at most `limit`. */
  pendingEvaluation(
    targetId: string,
    no: number,
    limit: number,
  ): Promise<WatchRecord[]>;
  /**
   * Marks the watches as evaluated for observation `no` at price `priceMinor`; returns the ids that were still
   * pending (the at-most-once guard).
   */
  claimEvaluation(
    watchIds: string[],
    no: number,
    priceMinor: number,
  ): Promise<string[]>;
  countActiveForTarget(targetId: string): Promise<number>;
}

export interface DueTarget {
  id: string;
  host: string;
}

export const TARGET_REPOSITORY = Symbol('S41_TARGET_REPOSITORY');
export interface TargetRepository {
  /** Inserts the target or returns the stored one (unique normalised URL). */
  upsertByUrl(url: string, host: string, now: Date): Promise<TargetRecord>;
  findById(id: string): Promise<TargetRecord | null>;
  findByUrl(url: string): Promise<TargetRecord | null>;
  /** A registration makes a target due only if it was last checked at least `minAgeMs` ago. */
  pullForward(targetId: string, now: Date, minAgeMs: number): Promise<void>;
  /** Due, watched, not retired targets with an active watch; highest plan first, then earliest due. */
  due(now: Date, limit: number): Promise<DueTarget[]>;
  /** Targets whose state shows an observation that was not fully evaluated. */
  unevaluated(limit: number): Promise<string[]>;
  /** Overdue count and age (seconds) of the most overdue watched target. */
  overdue(now: Date): Promise<{ count: number; oldestSeconds: number }>;
  /** Outcome of a crawl that recorded no observation. */
  recordOutcome(input: {
    id: string;
    status: CrawlStatus;
    now: Date;
    nextCheckAt: Date;
    unchangedStreak?: number;
    noPriceStreak?: number;
    errorStreak?: number;
    simhash?: string | null;
  }): Promise<void>;
  /**
   * The observation step: applies only if `observationNo` still equals `expectedNo`. Returns the new counter, or
   * `null` when another worker got there first.
   */
  recordObservation(input: {
    id: string;
    expectedNo: number;
    priceMinor: number;
    currency: string;
    simhash: string;
    now: Date;
    nextCheckAt: Date;
  }): Promise<number | null>;
  setEvaluated(id: string, no: number): Promise<void>;
  /** Marks the targets without an active or paused watch as retired. */
  retireUnwatched(targetIds: string[], now: Date): Promise<number>;
  /** Deletes retired targets older than `before` that still have no watch; returns the count (`SKIP LOCKED`). */
  purgeRetired(before: Date, batch: number): Promise<number>;
  /** Un-retires a target a new watch points at. */
  revive(targetId: string): Promise<void>;
}

export interface CompetitorShopRecord {
  shopId: string;
  plan: string | null;
  status: string;
  version: number;
}

export const COMPETITOR_SHOP_REPOSITORY = Symbol(
  'S41_COMPETITOR_SHOP_REPOSITORY',
);
export interface CompetitorShopRepository {
  /** `forUpdate` locks the row for the rest of the active transaction (the version guard of the consumer). */
  find(
    shopId: string,
    forUpdate?: boolean,
  ): Promise<CompetitorShopRecord | null>;
  findMany(shopIds: string[]): Promise<Map<string, CompetitorShopRecord>>;
  upsert(record: CompetitorShopRecord, now: Date): Promise<void>;
  remove(shopId: string): Promise<void>;
}

export interface ObservationPoint {
  observedAt: Date;
  priceMinor: number;
  currency: string;
}

export const OBSERVATION_HISTORY = Symbol('S41_OBSERVATION_HISTORY');
export interface ObservationHistory {
  /** Idempotent on (target, observationNo); throws `ObservationHistoryUnavailable` when the store is down. */
  append(row: {
    targetId: string;
    observationNo: number;
    observedAt: Date;
    priceMinor: number;
    currency: string;
  }): Promise<void>;
  /** Oldest first, at most `limit` of the newest rows in `[from, to]`. */
  read(
    targetId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<ObservationPoint[]>;
}

export const PAGE_ARCHIVE = Symbol('S41_PAGE_ARCHIVE');
export interface PageArchive {
  put(key: string, html: string): Promise<void>;
  /** Keeps the 7-day expiry of the archive prefix in place (idempotent, never throws). */
  ensureLifecycle(): Promise<void>;
}

export type RobotsEntry =
  | { outcome: 'rules'; rules: RobotsRules; expiresAt: number }
  | { outcome: 'allow_all'; expiresAt: number }
  | { outcome: 'unavailable'; expiresAt: number };

export const ROBOTS_CACHE = Symbol('S41_ROBOTS_CACHE');
export interface RobotsCache {
  get(origin: string, nowMs: number): Promise<RobotsEntry | null>;
  put(origin: string, entry: RobotsEntry, ttlSeconds: number): Promise<void>;
}

export const FRONTIER = Symbol('S41_FRONTIER');
export interface FrontierPort {
  push(host: string, targetId: string): Promise<void>;
  /** Takes one target of a host that may be hit now and leases the host; `null` when none is ready. */
  take(): Promise<{ host: string; targetId: string } | null>;
  /** The host may be hit again after `delayMs`. */
  release(host: string, delayMs: number): Promise<void>;
  /** Hosts with queued targets. */
  readyHosts(): Promise<number>;
  /**
   * The queue mark of a target: `true` if it was set (or an older one than `staleMs` was replaced), `false` if a
   * fresh mark exists.
   */
  mark(targetId: string, nowMs: number, staleMs: number): Promise<boolean>;
  unmark(targetId: string): Promise<void>;
}

export const SEEN_SET = Symbol('S41_SEEN_SET');
export interface SeenSet {
  contains(url: string): Promise<boolean>;
  add(url: string): Promise<void>;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  truncated: boolean;
  finalUrl: string;
  redirects: number;
}

export const SAFE_FETCHER = Symbol('S41_SAFE_FETCHER');
export interface SafeFetcher {
  /** Throws `SafeRequestError` (S54 vocabulary) for a refused or failed request. */
  get(
    url: string,
    options?: { deadlineMs?: number; robots?: boolean },
  ): Promise<FetchResult>;
  /** The guard alone, without a request (registration): throws `SafeRequestError`. */
  check(url: string): Promise<void>;
}
