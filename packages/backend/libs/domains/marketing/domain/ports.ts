import type { LinkStatsRange } from '@marketplace-sandbox/contracts';
import type { StoredStatus } from './link-state';

/**
 * Ports of share links (S37 L1, D-6): the application layer depends on these tokens only; `infra/` binds the DynamoDB,
 * Redis, Kafka and ClickHouse adapters. Tests wrap the same tokens with fault-injecting decorators. Time comes from
 * `Clock`/`CLOCK` (`@app/common/core/clock`).
 */

/** The link item as stored (data-model.md). Rows written before S37 may lack `status`, `kind`, `updatedAt`. */
export interface StoredLink {
  code: string;
  kind: 'generated' | 'custom';
  ownerId: string;
  destination: string;
  status: StoredStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  disabledAt?: string;
}

export const LINK_REPOSITORY = Symbol('LINK_REPOSITORY');
export const CODE_SEQUENCE = Symbol('CODE_SEQUENCE');
export const EXISTENCE_FILTER = Symbol('EXISTENCE_FILTER');
export const CLICK_PUBLISHER = Symbol('CLICK_PUBLISHER');
export const CLICK_STATS_READER = Symbol('CLICK_STATS_READER');
export const DESTINATION_REPUTATION = Symbol('DESTINATION_REPUTATION');
export const LINK_CACHE = Symbol('LINK_CACHE');

/** The store could not answer in time or failed; never "not found" (FR-046). */
export class DependencyUnavailableError extends Error {
  constructor(
    readonly dependency: string,
    cause?: unknown,
  ) {
    super(`${dependency} unavailable`);
    this.name = 'DependencyUnavailableError';
    this.cause = cause;
  }
}

export type CreateOutcome = 'created' | 'code_taken' | 'limit_reached';
export type UpdateOutcome =
  | { kind: 'updated'; link: StoredLink }
  | { kind: 'not_found' }
  | { kind: 'not_active' };

export interface ListCursorKey {
  createdAt: string;
  code: string;
}

export interface LinkRepository {
  /**
   * One atomic step: the link (only if the code is free) and the owner's active counter (only below `limit`). When the
   * counter is full it is recounted from the owner's live links once before answering `limit_reached`.
   */
  create(
    link: StoredLink,
    limit: number,
    nowIso: string,
  ): Promise<CreateOutcome>;
  /** Redirect read: timeout 500 ms. */
  get(code: string): Promise<StoredLink | null>;
  getOwned(ownerId: string, code: string): Promise<StoredLink | null>;
  /** Conditional on owner, `ACTIVE` and not expired; no match re-reads and answers `not_found` or `not_active`. */
  updateDestination(
    ownerId: string,
    code: string,
    destination: string,
    nowIso: string,
  ): Promise<UpdateOutcome>;
  /** Final; frees a place in the owner's counter in the same step. */
  disable(
    ownerId: string,
    code: string,
    nowIso: string,
  ): Promise<UpdateOutcome>;
  /** Newest first, `limit + 1` rows at most so the caller can tell whether another page exists. */
  listByOwner(
    ownerId: string,
    limit: number,
    after?: ListCursorKey,
  ): Promise<StoredLink[]>;
  /** At most 100 codes, one batched read; missing codes are omitted. */
  batchGet(codes: string[]): Promise<StoredLink[]>;
  /** Every code in the table, in pages (filter rebuild). */
  scanCodes(
    pageSize: number,
    startKey?: unknown,
  ): Promise<{ codes: string[]; next?: unknown }>;
}

export interface CodeSequence {
  /** Next number of the shared counter, leased in blocks of 1,000. */
  next(): Promise<number>;
}

export type FilterAnswer = 'absent' | 'maybe' | 'bypassed';

export interface ExistenceFilter {
  /** `bypassed` while the ready marker is missing or the filter store fails: the filter never says "absent" then. */
  check(code: string): Promise<FilterAnswer>;
  add(code: string): Promise<void>;
  /** Rebuild support (AS-33). */
  tryLockRebuild(): Promise<boolean>;
  addMany(codes: string[]): Promise<void>;
  markReady(): Promise<void>;
  unlockRebuild(): Promise<void>;
  /** Forget the ready marker (a rebuild starts from "not trusted"). */
  clearReady(): Promise<void>;
}

export interface ClickEnvelope {
  eventId: string;
  type: 'link.clicked';
  version: number;
  aggregateType: 'links';
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  payload: {
    clickId: string;
    code: string;
    ts: string;
    country: string;
    referer: string;
    viaEdge: boolean;
  };
}

export interface ClickPublisher {
  /** Returns at once; the publish (with bounded retry) runs off the request path and is tracked for the drain. */
  publish(envelope: ClickEnvelope): void;
  /** Wait for in-flight publishes, at most `timeoutMs`. */
  drain(timeoutMs: number): Promise<void>;
}

export interface ClickStatsQuery {
  code: string;
  from: Date;
  to: Date;
  bucket: 'minute' | 'hour' | 'day';
}
export interface ClickStats {
  total: number;
  series: Array<{ start: string; clicks: number }>;
  countries: Array<{ country: string; clicks: number }>;
}
export interface ClickStatsReader {
  read(query: ClickStatsQuery): Promise<ClickStats>;
}

export interface DestinationReputation {
  /** Fail closed: a timeout throws `DependencyUnavailableError`. */
  check(destination: string, ownerId: string): Promise<'allow' | 'block'>;
}

export interface LinkCache {
  /** Cache-aside: fresh 1 h, stale up to 24 h when the store fails, misses remembered 60 s, errors never stored. */
  getOrLoad(
    code: string,
    loader: () => Promise<StoredLink | null>,
  ): Promise<StoredLink | null>;
  invalidate(code: string): Promise<void>;
}

export const STATS_BUCKET: Record<LinkStatsRange, 'minute' | 'hour' | 'day'> = {
  '24h': 'minute',
  '7d': 'hour',
  '30d': 'day',
};
export const STATS_WINDOW_MS: Record<LinkStatsRange, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
};
