/**
 * Ports of the autocomplete slice (D-6, constitution I.2). `application/` depends on these; adapters in `infra/` bind
 * them through the tokens below. Nothing here imports Nest, Redis, ClickHouse, the object store or the engine client.
 */

export interface SnapshotObject {
  version: string;
  lastModified: Date;
}

/** Immutable snapshot objects, one per version. */
export interface QueryIndexSnapshotStore {
  put(version: string, body: Buffer): Promise<void>;
  /** The stored bytes, or `null` when the object does not exist. */
  get(version: string): Promise<Buffer | null>;
  list(): Promise<SnapshotObject[]>;
  delete(version: string): Promise<void>;
}

/** Which snapshot version serving nodes follow. */
export interface SnapshotPointer {
  read(): Promise<string | null>;
  /** Moves the pointer forward only (`canAdvance`); returns whether it moved. */
  compareAndSet(version: string): Promise<boolean>;
  /** Operator path: sets the pointer to any version, backwards included. */
  forceSet(version: string): Promise<void>;
}

export interface EligibleQueryParams {
  windowDays: number;
  minSearchers: number;
  cap: number;
}

export interface EligibleQueryRow {
  query: string;
  searchers: number;
}

/** Read-only view of the discovery search log: distinct searchers per query, already counted. */
export interface SearchLogReader {
  eligibleQueries(
    params: EligibleQueryParams,
    signal?: AbortSignal,
  ): Promise<EligibleQueryRow[]>;
}

/** Thrown by a `CatalogTitleSource` when it did not answer within the budget (the signal fired). */
export class CatalogTimeoutError extends Error {
  constructor() {
    super('catalog title source timed out');
    this.name = 'CatalogTimeoutError';
  }
}

/** Visible product titles starting with / close to a prefix (S32 `ProductTitleSuggester`). */
export interface CatalogTitleSource {
  suggestTitles(
    prefix: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<string[]>;
  suggestTitlesFuzzy(
    prefix: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<string[]>;
}

export interface AutocompleteClock {
  now(): Date;
}

export const QUERY_INDEX_SNAPSHOT_STORE = Symbol('QUERY_INDEX_SNAPSHOT_STORE');
export const SNAPSHOT_POINTER = Symbol('SNAPSHOT_POINTER');
export const SEARCH_LOG_READER = Symbol('SEARCH_LOG_READER');
export const CATALOG_TITLE_SOURCE = Symbol('CATALOG_TITLE_SOURCE');
export const AUTOCOMPLETE_CLOCK = Symbol('AUTOCOMPLETE_CLOCK');
