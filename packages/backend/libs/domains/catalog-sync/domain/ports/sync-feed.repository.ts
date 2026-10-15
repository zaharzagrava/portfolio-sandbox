import type { SyncChangeData } from '@marketplace-sandbox/contracts';

export const SYNC_FEED_REPOSITORY = Symbol('SYNC_FEED_REPOSITORY');

export interface FeedEntryInput {
  productId: string;
  version: number;
  deleted: boolean;
  /** Null for a tombstone. */
  data: SyncChangeData | null;
  occurredAt: Date;
}

export interface FeedEntry {
  seq: number;
  productId: string;
  version: number;
  deleted: boolean;
  data: SyncChangeData | null;
}

export interface FeedState {
  lastSeq: number;
  /** 0: the feed was not built by this capability yet (legacy rows, or events seen before the first backfill). */
  generation: number;
  horizonSeq: number;
  horizonAt: Date | null;
}

export interface SyncFeedRepository {
  /**
   * One transaction under the shop's `ShopSyncState` row lock (created on first use): `duplicate` when the version is
   * already there, `stale` when a newer one is, else the entry gets `lastSeq + 1`. A rolled-back append leaves no hole.
   */
  append(
    shopId: string,
    entry: FeedEntryInput,
  ): Promise<'appended' | 'duplicate' | 'stale'>;
  /** Entries after `afterSeq` in increasing `seq`. */
  page(
    shopId: string,
    afterSeq: number,
    limit: number,
    options?: { latestOnly?: boolean },
  ): Promise<FeedEntry[]>;
  state(shopId: string): Promise<FeedState | null>;
  /**
   * Removes entries created before `before` that a newer entry of the product supersedes, and tombstones older than
   * that; the newest entry of a live product stays. Raises the horizon to the highest removed `seq`.
   */
  compact(
    shopId: string,
    before: Date,
    limit: number,
    now: Date,
  ): Promise<{ removed: number; horizonSeq: number }>;
  /** Shops with entries older than `before` (the compaction job's work list), `after` is the keyset. */
  shopsWithEntriesBefore(
    before: Date,
    after: string | null,
    limit: number,
  ): Promise<string[]>;
  /** Next generation for the shop (state row created if missing); legacy entries without a version are removed. */
  startGeneration(shopId: string): Promise<number>;
  deleteShop(shopId: string, limit: number): Promise<number>;
}
