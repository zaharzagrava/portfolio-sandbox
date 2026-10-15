import type { SyncResultCode } from '@marketplace-sandbox/contracts';

export const SYNC_OPERATION_REPOSITORY = Symbol('SYNC_OPERATION_REPOSITORY');

export type SyncOpType = 'stock.adjust' | 'stock.count' | 'product.update';
export type SyncOpStatus =
  'pending' | 'applied' | 'merged' | 'conflict' | 'rejected';
export type SyncConflictKind = 'oversold' | 'quantity_limit';

/** One device operation as stored (data-model.md). Every lookup carries the shop. */
export interface SyncOperationRow {
  shopId: string;
  opId: string;
  deviceId: string;
  userId: string | null;
  type: SyncOpType;
  productId: string | null;
  hlc: string;
  /** Null only for a legacy row written before the fingerprint existed. */
  fingerprint: string | null;
  content: Record<string, unknown> | null;
  status: SyncOpStatus;
  code: SyncResultCode | null;
  detail: Record<string, unknown> | null;
  quantityAfter: number | null;
  productVersion: number | null;
  claimedAt: Date;
  createdAt: Date;
  completedAt: Date | null;
}

export interface ClaimInput {
  shopId: string;
  opId: string;
  deviceId: string;
  userId: string;
  type: SyncOpType;
  productId: string;
  hlc: string;
  fingerprint: string;
  content: Record<string, unknown>;
  now: Date;
}

/** What is recorded for a finished operation (`retry` is never stored). */
export interface OutcomeRecord {
  status: Exclude<SyncOpStatus, 'pending'>;
  code?: SyncResultCode;
  detail?: Record<string, unknown>;
  quantityAfter?: number;
  productVersion?: number;
}

/** The numbers of an `oversold` / `quantity_limit` result; recorded with the outcome (FR-030). */
export interface ConflictInput {
  deviceId: string;
  productId: string;
  kind: SyncConflictKind;
  requested: number;
  applied: number;
  shortfall: number;
  quantityAfter: number;
}

export interface SyncOperationRepository {
  /** Inserts a `pending` row, committed at once (the claim); on `(shopId, opId)` conflict returns the existing row. */
  claim(
    input: ClaimInput,
  ): Promise<{ kind: 'claimed' } | { kind: 'existing'; row: SyncOperationRow }>;
  /** Moves the lease of a stale claim to `now` if it still equals what the caller saw; exactly one caller wins. */
  takeOver(
    shopId: string,
    opId: string,
    seenClaimedAt: Date,
    now: Date,
  ): Promise<boolean>;
  /**
   * One transaction: the conditional `pending -> terminal` update, the `SyncConflict` row and the
   * `catalog_sync.offline_conflict_opened` outbox row. `false` when the row was no longer pending (nothing is written,
   * so a re-recorded result creates neither a second conflict nor a second event).
   */
  complete(
    shopId: string,
    opId: string,
    outcome: OutcomeRecord,
    conflict: ConflictInput | null,
    now: Date,
  ): Promise<boolean>;
  /**
   * Keeps what a half-finished operation has decided (the clamp it is about to apply) on its pending row, so a takeover
   * repeats that decision instead of making a new one. `false` when the row is no longer pending.
   */
  savePlan(
    shopId: string,
    opId: string,
    plan: Record<string, unknown>,
  ): Promise<boolean>;
  /** Records a result for an operation that was never claimed (a rejection decided before the catalog is touched). */
  recordRejected(
    input: ClaimInput,
    outcome: OutcomeRecord,
  ): Promise<
    { kind: 'recorded' } | { kind: 'existing'; row: SyncOperationRow }
  >;
  find(shopId: string, opId: string): Promise<SyncOperationRow | null>;
  /** Pending claims older than `before`, oldest first (the recovery job). */
  listStale(before: Date, limit: number): Promise<SyncOperationRow[]>;
  /** Terminal records created before `before`, except those of an open conflict. */
  purgeBefore(before: Date, limit: number): Promise<number>;
  countPending(): Promise<number>;
  deleteShop(shopId: string, limit: number): Promise<number>;
}
