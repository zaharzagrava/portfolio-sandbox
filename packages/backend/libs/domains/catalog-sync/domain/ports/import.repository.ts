import type {
  ImportFailureCode,
  ImportStatus,
} from '@marketplace-sandbox/contracts';

export const IMPORT_REPOSITORY = Symbol('IMPORT_REPOSITORY');

/** One `ImportJob` row (data-model.md). Internal: never in a DTO or a log (storage key, upload handle, lease). */
export interface ImportJobRecord {
  id: string;
  shopId: string;
  createdBy: string;
  status: ImportStatus;
  fileName: string;
  sizeBytes: number;
  storageKey: string;
  uploadHandle: string | null;
  slot: number | null;
  format: 'csv' | 'jsonl' | null;
  headerColumns: string[] | null;
  ignoredColumns: string[];
  scan: 'clean' | 'skipped' | null;
  scannedAt: Date | null;
  rowsProcessed: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  rowsFailed: number;
  lastRow: number;
  nextByteOffset: number;
  bytesProcessed: number;
  failureCode: ImportFailureCode | null;
  failureDetail: string | null;
  errorReportKey: string | null;
  errorReportRows: number;
  leaseHolder: string | null;
  leaseExpiresAt: Date | null;
  cancelRequestedAt: Date | null;
  lastEnqueuedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ImportCounters {
  rowsProcessed: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  rowsFailed: number;
}

export interface ImportHistoryEntry {
  status: ImportStatus;
  at: Date;
}

export interface ImportJobPage {
  items: ImportJobRecord[];
  nextCursor: string | null;
}

export interface TransitionInput {
  importId: string;
  /** Present for a user-facing change: the predicate carries the principal's shop (III.4). */
  shopId?: string;
  from: ImportStatus;
  to: ImportStatus;
  reason?: string;
  now: Date;
  /** A runner's change: also requires this lease holder and an unexpired lease; the lease is released on a final status. */
  leaseHolder?: string;
  failure?: { code: ImportFailureCode; detail?: string };
  scan?: 'clean' | 'skipped';
  /** Final status: the bytes read in total. */
  bytesProcessed?: number;
  /** Clears the open multipart handle (abort, complete or final). */
  clearUploadHandle?: boolean;
}

export interface CommitBatchInput {
  importId: string;
  leaseHolder: string;
  now: Date;
  leaseMs: number;
  /** Counter deltas of the batch. */
  delta: ImportCounters;
  lastRow: number;
  nextByteOffset: number;
  bytesProcessed: number;
  errorReportLines: number;
  /** Stored once, with the first checkpoint (D-08). */
  header?: {
    format: 'csv' | 'jsonl';
    headerColumns: string[] | null;
    ignoredColumns: string[];
  };
}

export type ClaimResult =
  | { kind: 'claimed'; job: ImportJobRecord }
  | { kind: 'held' }
  | { kind: 'busy' }
  | { kind: 'final'; job: ImportJobRecord }
  | { kind: 'missing' };

/** Every method that serves a request takes the shop (III.4). Conditional updates return `null`/`false` when refused. */
export interface ImportRepository {
  /** Inserts a `PENDING_UPLOAD` job in the lowest free slot, with its first history row; `cap` when the shop has three. */
  insertPending(input: {
    id: string;
    shopId: string;
    createdBy: string;
    fileName: string;
    sizeBytes: number;
    storageKey: string;
    now: Date;
  }): Promise<{ kind: 'created'; job: ImportJobRecord } | { kind: 'cap' }>;
  /** `PENDING_UPLOAD` and no handle yet. */
  setUploadHandle(
    importId: string,
    shopId: string,
    handle: string,
    now: Date,
  ): Promise<boolean>;
  findForShop(
    shopId: string,
    importId: string,
  ): Promise<ImportJobRecord | null>;
  /** Unscoped by shop: ONLY for the worker (whose message carries just the id) and the topic policy. */
  findById(importId: string): Promise<ImportJobRecord | null>;
  history(importId: string): Promise<ImportHistoryEntry[]>;
  list(
    shopId: string,
    query: { status?: ImportStatus; limit: number; cursor?: string },
  ): Promise<ImportJobPage>;
  /**
   * `from -> to` by one conditional update plus its history row; a final `to` also releases the lease and writes the
   * `catalogsync.import_finished` outbox entry, all in one transaction. `null` when the row is not in `from` (or the
   * fence fails): nothing was written.
   */
  transition(input: TransitionInput): Promise<ImportJobRecord | null>;
  /** Takes the right to run: a lease, and `UPLOADED -> SCANNING` when the job was `UPLOADED`. */
  claim(input: {
    importId: string;
    leaseHolder: string;
    now: Date;
    leaseMs: number;
  }): Promise<ClaimResult>;
  renewLease(
    importId: string,
    leaseHolder: string,
    now: Date,
    leaseMs: number,
  ): Promise<boolean>;
  /** Conditional on the holder; a holder that lost the lease releases nothing. */
  releaseLease(importId: string, leaseHolder: string): Promise<void>;
  /** Fenced counters + checkpoint as one unit; `null` when the lease is no longer this holder's. */
  commitBatch(
    input: CommitBatchInput,
  ): Promise<{ job: ImportJobRecord; cancelRequested: boolean } | null>;
  /** Marks a running job for cancel at its next safe point; `null` when it is not running. */
  requestCancel(
    shopId: string,
    importId: string,
    now: Date,
  ): Promise<ImportJobRecord | null>;
  /** The jobs to re-enqueue now, each stamped so no other run takes it within the window. */
  claimRecoverable(now: Date, limit: number): Promise<ImportJobRecord[]>;
  stampEnqueued(importId: string, now: Date): Promise<void>;
  findExpirable(now: Date, limit: number): Promise<ImportJobRecord[]>;
  findReportPurgeable(cutoff: Date, limit: number): Promise<ImportJobRecord[]>;
  clearReportKey(importId: string): Promise<boolean>;
  findRecordPurgeable(cutoff: Date, limit: number): Promise<ImportJobRecord[]>;
  /** Deletes the row and its history; `true` only for the call that deleted the row. */
  deleteJob(importId: string): Promise<boolean>;
  setErrorReportKey(importId: string, key: string): Promise<void>;
  nonFinalByShop(shopId: string): Promise<ImportJobRecord[]>;
  /** Deletes all rows and history of the shop in chunks; returns how many jobs were removed. */
  deleteByShop(shopId: string): Promise<number>;
  /** Age in ms of the oldest `PROCESSING` checkpoint, or `null` when nothing is running. */
  oldestCheckpointAgeMs(now: Date): Promise<number | null>;
}
