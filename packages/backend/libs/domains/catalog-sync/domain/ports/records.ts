import type { IntegrationStatus, PausedReason } from '../integration-status';
import type { ProviderName } from '../normalise';

/** Row shapes the repositories hand to `application/` (plain data, timestamps as `Date`). */
export interface IntegrationRecord {
  id: string;
  shopId: string;
  provider: ProviderName;
  externalShop: string;
  status: IntegrationStatus;
  pausedReason: PausedReason | null;
  /** Sealed with context `integration:<id>`; null after disconnect. */
  credentialsSealed: string | null;
  locationId: string | null;
  connectedBy: string | null;
  lastError: string | null;
  lastSyncAt: Date | null;
  consecutiveFailures: number;
  breakerOpenUntil: Date | null;
  nextSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type LinkState =
  'ACTIVE' | 'UNLISTED' | 'DELETED_AT_PROVIDER' | 'IGNORED';

export interface LinkRecord {
  integrationId: string;
  entity: string;
  /** `<productId>:<variantId>` */
  externalId: string;
  localId: string;
  shopId: string | null;
  state: LinkState;
  contentDigest: string | null;
  syncedStock: number | null;
  remoteUpdatedAt: Date | null;
  lastStockWriteAt: Date | null;
  lastLocalVersion: number | null;
  raw: unknown;
  updatedAt: Date;
}

export type SyncRunKind = 'incremental' | 'backfill' | 'one' | 'reconcile';
export type SyncRunOutcome =
  | 'completed'
  | 'completed_with_quarantine'
  | 'yielded'
  | 'failed'
  | 'skipped_locked'
  | 'skipped_breaker_open'
  | 'skipped_shop_not_active'
  | 'halted_schema_drift';

export interface SyncCounters {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  quarantined: number;
  stale: number;
}

export interface SyncRunRecord {
  id: string;
  integrationId: string;
  kind: SyncRunKind;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: SyncRunOutcome | null;
  counters: Partial<SyncCounters>;
  detail: string | null;
}

export type QuarantineStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';
export type QuarantineResolution =
  'fixed_at_provider' | 'dismissed' | 'expired';

export interface QuarantineRecord {
  id: string;
  integrationId: string;
  entity: string;
  externalId: string | null;
  dedupeKey: string;
  payloadDigest: string | null;
  reasonCode: string;
  message: string;
  payload: unknown;
  status: QuarantineStatus;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolution: QuarantineResolution | null;
  dismissedBy: string | null;
  resolvedAt: Date | null;
}

export type ConflictKind = 'oversold' | 'quantity_limit';
export type ConflictStatus = 'OPEN' | 'DISMISSED';

export interface ConflictRecord {
  id: string;
  integrationId: string;
  shopId: string;
  externalId: string;
  productId: string | null;
  kind: ConflictKind;
  base: number;
  local: number;
  remote: number;
  merged: number | null;
  resolvedTo: number | null;
  status: ConflictStatus;
  createdAt: Date;
  dismissedBy: string | null;
  dismissedAt: Date | null;
  resolution: string | null;
}

export type ReconciliationOutcome =
  'completed' | 'aborted_mass_delete' | 'failed';

export interface ReconciliationFinding {
  kind: string;
  externalId: string | null;
  detail?: string;
  /** Set on a finding carried over from the earlier run (AS-64). */
  previousRunId?: string;
  outcome?: 'fixed' | 'still_open';
}

export interface ReconciliationRecord {
  id: string;
  integrationId: string;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: ReconciliationOutcome | null;
  counts: Record<string, number>;
  findings: ReconciliationFinding[];
  truncated: boolean;
  previousRunId: string | null;
}

export interface InstallRecord {
  id: string;
  shopId: string;
  userId: string;
  shopDomain: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PageQuery {
  /** 1..100 */
  limit: number;
  /** Opaque cursor from a previous page; tampered or foreign -> `400 invalid_cursor`. */
  cursor?: string;
}

/** One variant as the provider showed it on a page (or a direct read). */
export interface StockCandidate {
  externalId: string;
  stock: number;
  updatedAt: Date;
}
