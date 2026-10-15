import type { SyncConflictKind } from './sync-operation.repository';

export const SYNC_CONFLICT_REPOSITORY = Symbol('SYNC_CONFLICT_REPOSITORY');

export type SyncConflictStatus = 'open' | 'dismissed';

export interface SyncConflictRecord {
  shopId: string;
  opId: string;
  deviceId: string;
  productId: string;
  kind: SyncConflictKind;
  requested: number;
  applied: number;
  shortfall: number;
  quantityAfter: number;
  status: SyncConflictStatus;
  createdAt: Date;
  dismissedAt: Date | null;
  dismissedBy: string | null;
}

export interface SyncConflictPage {
  items: SyncConflictRecord[];
  nextCursor: string | null;
}

export interface SyncConflictRepository {
  /** Newest first, ties by operation id; the cursor is opaque and bound to the shop and status. */
  page(
    shopId: string,
    query: { status: SyncConflictStatus; limit: number; cursor?: string },
  ): Promise<SyncConflictPage>;
  /** One conditional `open -> dismissed` update; `null` when it was not open (or not this shop's). */
  dismiss(
    shopId: string,
    opId: string,
    actorId: string,
    now: Date,
  ): Promise<SyncConflictRecord | null>;
  find(shopId: string, opId: string): Promise<SyncConflictRecord | null>;
  countOpen(): Promise<number>;
  deleteShop(shopId: string, limit: number): Promise<number>;
}
