import type { BoostTier } from './boost';
import type { IndexedDocument, Mutation } from './index-document';
import type { GuardOutcome } from './projection-guard';
import type { ReindexRunStatus } from './reindex-run-status';

export type ReindexRunKind = 'REINDEX' | 'ROLLBACK';

/**
 * Ports of the search domain. Domain and application code depend on these; adapters in `infra/` bind them through the
 * injection tokens below (I.1, I.2). Nothing here imports Nest, Sequelize, kafkajs or the engine client.
 */

/** The public products index (Elasticsearch behind the alias `products`). */
export interface ProductIndexPort {
  /** Stored documents by id from the index the alias points to (absent ids are left out). */
  read(ids: string[]): Promise<Map<string, IndexedDocument>>;
  /**
   * Applies each mutation to the stored document of every index in the write set (live index, the index a run is
   * building, the retained previous one) with compare-and-set writes; returns the outcome on the live index.
   */
  mutate(
    items: { id: string; mutation: Mutation }[],
  ): Promise<Map<string, GuardOutcome>>;
  /** Stored documents by id from one named index (a run reads the index it is building). */
  readFrom(index: string, ids: string[]): Promise<Map<string, IndexedDocument>>;
  /** Like `mutate`, but only on the named index (the replay of a run writes the index it is building, not the live one). */
  mutateOn(
    index: string,
    items: { id: string; mutation: Mutation }[],
  ): Promise<Map<string, GuardOutcome>>;
  /** One query to the engine: visible products only, filtered, sorted, cursor-paged. Throws `EngineUnavailableError`. */
  search(request: EngineSearchRequest): Promise<EngineSearchResult>;
  /** Stamps the shop state on every document of the shop whose stamp is older (waits for pending writes to be searchable). */
  stampShop(shopId: string, stamp: ShopStampWrite): Promise<void>;
  /** Removes every document of a shop (shop deleted). */
  purgeShop(shopId: string): Promise<void>;
  /** Removes tombstones older than the instant; returns how many. */
  purgeTombstones(before: Date): Promise<number>;
  /** Distinct shop ids that have documents, ascending, keyset (shop-state backfill). */
  distinctShopIds(after: string | null, limit: number): Promise<string[]>;
  /** Ids of documents with a popularity bucket above 0, ascending, keyset (so a bucket can decay to 0). */
  popularProductIds(after: string | null, limit: number): Promise<string[]>;
  /** Visible-or-not products indexed without a vector (embedding pending). */
  pendingEmbeddingIds(limit: number): Promise<string[]>;
}

/** What a public search asks of the engine (the application already validated and normalised it). */
export interface EngineSearchRequest {
  /** Normalised query text; null for browse. */
  q: string | null;
  filters: {
    category?: string;
    brand?: string;
    minPriceMinor?: number;
    maxPriceMinor?: number;
    minRating?: number;
    inStock?: boolean;
  };
  sort: 'relevance' | 'price-asc' | 'price-desc' | 'newest';
  /** Results wanted; the engine returns one more to tell whether another page exists. */
  limit: number;
  after: (string | number)[] | null;
}

export interface EngineSearchHit {
  id: string;
  /** The sort values of the hit, the next page's `search_after`. */
  sort: (string | number)[];
  source: Partial<IndexedDocument>;
}

export interface EngineSearchResult {
  hits: EngineSearchHit[];
  total: { value: number; exact: boolean };
}

/** What the engine says about a concrete index (from its `_meta`). */
export interface IndexInfo {
  name: string;
  mappingVersion: number | null;
  embeddingModelVersion: string | null;
  createdByRun: string | null;
  createdAt: Date | null;
}

/** Index lifecycle for runs: create, switch the live name, count, delete. Product documents go through `ProductIndexPort`. */
export interface IndexManagerPort {
  /** The index the live name points to; `concrete` for a legacy index that carries the name itself. */
  liveIndex(): Promise<{ name: string; concrete: boolean } | null>;
  /** Creates the empty index of a run (deterministic name, so a resumed run finds it) and returns its name. */
  createFor(runId: string): Promise<string>;
  /** Deletes an index unless it is the live one; never throws for an index that is already gone. */
  deleteUnlessLive(name: string): Promise<boolean>;
  info(name: string): Promise<IndexInfo | null>;
  /** Every concrete products index (never the live name of a legacy concrete one). */
  productIndices(): Promise<IndexInfo[]>;
  refresh(index: string): Promise<void>;
  /** Documents that are products (not tombstones, not signal-only). */
  countProducts(index: string): Promise<number>;
  countPendingEmbeddings(index: string): Promise<number>;
  /** Atomically points the live name at `target` (replacing a legacy concrete index in the same step). */
  switchLive(target: string): Promise<void>;
}

/** How far the live projector is behind the stream, in seconds (0 when caught up or when no group exists). */
export interface ProjectionLagPort {
  seconds(): Promise<number>;
}

export interface ShopStampWrite {
  status: string;
  hidden: boolean;
  tier: BoostTier | null;
  version: number | null;
  at: string;
}

export interface ShopStateRecord {
  shopId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
  plan: 'STARTER' | 'PRO' | 'ENTERPRISE' | null;
  shopVersion: number | null;
  offboarding: boolean;
  lastEventAt: Date;
}

/** What a shop event changes in the copy: only the keys present are written. */
export interface ShopStateChange {
  shopId: string;
  status?: ShopStateRecord['status'];
  plan?: ShopStateRecord['plan'];
  offboarding?: boolean;
  shopVersion: number | null;
  occurredAt: Date;
}

export interface ShopStateRepository {
  read(shopIds: string[]): Promise<Map<string, ShopStateRecord>>;
  /** Version-guarded upsert; returns the stored row after the call and whether the change was applied. */
  apply(
    change: ShopStateChange,
  ): Promise<{ outcome: GuardOutcome; record: ShopStateRecord }>;
}

export interface ShopProductRow {
  productId: string;
  shopId: string;
  title: string;
  brand: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  priceMinor: number;
  currency: string;
  quantity: number;
  isSandbox: boolean;
  productVersion: number;
}

export interface ShopSearchRepository {
  /** Version-guarded upserts (one statement); a tombstone is only replaced by a higher-version `created`. */
  upsert(
    rows: (ShopProductRow & { kind: 'created' | 'updated' | 'archived' | 'restored' })[],
  ): Promise<void>;
  /** Tombstones: `deletedAt` = the event time, kept for the retention window. */
  markDeleted(
    rows: {
      productId: string;
      shopId: string;
      productVersion: number;
      at: Date;
    }[],
  ): Promise<void>;
  purgeShop(shopId: string): Promise<void>;
  purgeTombstones(before: Date): Promise<number>;
}

export interface EmbeddingProvider {
  readonly modelVersion: string;
  /** A vector for the text, or rejects; honours the signal (budget). */
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}

export interface ProductImageResolver {
  /** Thumbnail URLs by media id (ids that are not ready are left out). */
  thumbnails(mediaIds: string[]): Promise<Map<string, string>>;
}

export interface ReindexRunRecord {
  runId: string;
  kind: ReindexRunKind;
  status: ReindexRunStatus;
  mappingVersion: number;
  embeddingModelVersion: string;
  index: string | null;
  previousIndex: string | null;
  previousRetiresAt: Date | null;
  replayPosition: Record<string, unknown>;
  documents: number;
  ledger: Record<string, number>;
  failureReason: string | null;
  switchingAt: Date | null;
  requestedBy: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface NewReindexRun {
  runId: string;
  kind: ReindexRunKind;
  mappingVersion: number;
  embeddingModelVersion: string;
  requestedBy: string | null;
  /** Rollback runs know their target (the retained index) and the index they replace when they are queued. */
  index?: string | null;
  previousIndex?: string | null;
  now: Date;
}

/** Fields a status move may set besides the status itself. Only the keys present are written. */
export interface ReindexRunPatch {
  index?: string | null;
  previousIndex?: string | null;
  previousRetiresAt?: Date | null;
  documents?: number;
  replayPosition?: Record<string, unknown>;
  ledger?: Record<string, number>;
  failureReason?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export interface ReindexRunHistoryEntry {
  fromStatus: string | null;
  toStatus: string;
  at: Date;
  detail: Record<string, unknown>;
}

export interface ReindexRunRepository {
  /** Inserts a QUEUED run; rejects with `ActiveRunExistsError` when a run is already active. */
  insertQueued(run: NewReindexRun): Promise<ReindexRunRecord>;
  get(runId: string): Promise<ReindexRunRecord | null>;
  /** Newest first, keyset on (createdAt, runId). */
  list(
    limit: number,
    cursor: { createdAt: Date; runId: string } | null,
  ): Promise<ReindexRunRecord[]>;
  history(runId: string): Promise<ReindexRunHistoryEntry[]>;
  findActive(): Promise<ReindexRunRecord | null>;
  latestCompleted(): Promise<ReindexRunRecord | null>;
  /** The index an active run is building plus the previous index the latest completed run retains. */
  retainedIndexes(): Promise<string[]>;
  /**
   * `UPDATE … WHERE runId AND status = from` plus a history row in one transaction; null when the run was not in
   * `from` (someone else moved it).
   */
  transition(
    runId: string,
    from: ReindexRunRecord['status'],
    to: ReindexRunRecord['status'],
    patch: ReindexRunPatch,
    at: Date,
    detail?: Record<string, unknown>,
  ): Promise<ReindexRunRecord | null>;
  /** Cancel that loses against a run that has already claimed the switch. */
  cancel(runId: string, at: Date): Promise<ReindexRunRecord | null>;
  progress(runId: string, patch: ReindexRunPatch): Promise<void>;
  /** Claims the right to switch the alias (`switchingAt`); false when cancel or another worker won. */
  claimSwitch(runId: string, at: Date): Promise<boolean>;
  /** The retained previous index of a completed run was deleted: stop writing to it. */
  clearPrevious(runId: string): Promise<void>;
}

export interface SynonymSetSnapshot {
  version: number;
  rules: string[];
  updatedAt: Date;
  updatedBy: string | null;
}

export interface SynonymSetRepository {
  /** The committed set (seeded at version 1 by the migration; recreated when missing). */
  current(): Promise<SynonymSetSnapshot>;
}

/**
 * Points in a reindex run where a spec may pause it, tamper with the index or simulate a crash (the worker dying).
 * Production binds the empty probe; the run executor awaits every hook that is present.
 */
export interface ReindexProbe {
  afterBuildingStarted?(run: ReindexRunRecord): Promise<void>;
  afterBatch?(run: ReindexRunRecord, batch: number): Promise<void>;
  afterReplay?(run: ReindexRunRecord): Promise<void>;
  beforeSwitch?(run: ReindexRunRecord): Promise<void>;
  afterSwitch?(run: ReindexRunRecord): Promise<void>;
}

/** Thrown by a probe to model the process dying: the executor leaves the run exactly as it is. */
export class SimulatedCrash extends Error {
  constructor() {
    super('simulated worker crash');
    this.name = 'SimulatedCrash';
  }
}

export class ActiveRunExistsError extends Error {
  constructor(readonly activeRunId: string) {
    super('a reindex run is already active');
    this.name = 'ActiveRunExistsError';
  }
}

/** What a search tells the event stream; never throws, a failed publish is counted (FR-052, FR-059). */
export interface SearchPerformedRecord {
  searchId: string;
  rawQuery: string;
  results: number;
  mode: 'browse' | 'lexical' | 'semantic';
  filters: string[];
  degraded: string[];
  surface: 'http' | 'internal';
  /** Who searched: the user id, or the client address; hashed before it leaves the process. */
  subject: string;
}

export interface SearchEventPublisher {
  performed(record: SearchPerformedRecord): void;
}

export const INDEX_MANAGER = Symbol('IndexManagerPort');
export const PROJECTION_LAG = Symbol('ProjectionLagPort');
export const REINDEX_PROBE = Symbol('ReindexProbe');
export const PRODUCT_INDEX = Symbol('ProductIndexPort');
export const SHOP_STATE_REPOSITORY = Symbol('ShopStateRepository');
export const SHOP_SEARCH_REPOSITORY = Symbol('ShopSearchRepository');
export const EMBEDDING_PROVIDER = Symbol('EmbeddingProvider');
export const PRODUCT_IMAGE_RESOLVER = Symbol('ProductImageResolver');
export const REINDEX_RUN_REPOSITORY = Symbol('ReindexRunRepository');
export const SYNONYM_SET_REPOSITORY = Symbol('SynonymSetRepository');
export const SEARCH_EVENT_PUBLISHER = Symbol('SearchEventPublisher');
