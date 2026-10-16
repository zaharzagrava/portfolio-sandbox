import type { Readable, Writable } from 'node:stream';
import type { KeysetPosition, RawExportRow } from './export-row';
import type { ExportFailureCode } from './export-failure';
import type { ExportStatus } from './export-state';

/** Injection tokens and interfaces of the export (S12 data-model.md, Ports). The domain depends on these only. */
export const EXPORT_JOBS = Symbol('EXPORT_JOBS');
export const EXPORT_LINES = Symbol('EXPORT_LINES');
export const EXPORT_FILES = Symbol('EXPORT_FILES');
export const EXPORT_SKUS = Symbol('EXPORT_SKUS');
export const EXPORT_LIVE = Symbol('EXPORT_LIVE');
export const EXPORT_QUEUE = Symbol('EXPORT_QUEUE');

/** The platform's injected time source (tests move it); export code never calls `new Date()` for a decision. */
export { CLOCK, type Clock } from '@app/common/core/clock';

export interface ExportJobRecord {
  id: string;
  shopId: string;
  createdBy: string;
  status: ExportStatus;
  attempt: number;
  totalRows: number | null;
  rowsWritten: number;
  bytesWritten: number;
  failureCode: ExportFailureCode | null;
  /** Internal: never in a DTO or log. */
  fileKey: string | null;
  leaseHolder: string | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type FinalStatus = 'DONE' | 'FAILED' | 'CANCELLED';

export interface ExportJobPage {
  items: ExportJobRecord[];
  nextCursor: string | null;
}

/** Every method that touches one job takes the shop (FR-028). Conditional updates return `false` when refused. */
export interface ExportJobsPort {
  /** Creates a `QUEUED` job unless the shop has an active one (then `{ activeExportId }`). */
  createWithActiveGuard(input: {
    shopId: string;
    createdBy: string;
    now: Date;
  }): Promise<
    | { kind: 'created'; job: ExportJobRecord }
    | { kind: 'active'; activeExportId: string }
  >;
  findByShop(shopId: string, exportId: string): Promise<ExportJobRecord | null>;
  /** Unscoped by shop: ONLY for the worker, whose queue message carries just the export id. */
  findById(exportId: string): Promise<ExportJobRecord | null>;
  /** Re-read with the fencing token (cancel/fence check at batch boundaries); `null` when the job is gone. */
  readLease(
    exportId: string,
    leaseHolder: string,
  ): Promise<{ status: ExportStatus; leaseValid: boolean } | null>;
  list(
    shopId: string,
    query: { status?: ExportStatus; limit: number; cursor?: string },
  ): Promise<ExportJobPage>;
  /** `QUEUED` -> `RUNNING` with a fresh lease holder; `null` when not claimable. */
  claim(input: {
    exportId: string;
    leaseHolder: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ExportJobRecord | null>;
  heartbeat(
    exportId: string,
    leaseHolder: string,
    leaseExpiresAt: Date,
  ): Promise<boolean>;
  recordProgress(
    exportId: string,
    leaseHolder: string,
    progress: { rowsWritten: number; bytesWritten: number; totalRows?: number },
  ): Promise<boolean>;
  /** Final status, history row and `order_export.finished` outbox entry in one transaction. */
  finish(input: {
    exportId: string;
    leaseHolder: string | null;
    to: FinalStatus;
    failureCode?: ExportFailureCode;
    fileKey?: string;
    rowsWritten: number;
    bytesWritten: number;
    now: Date;
    /** `DONE`: when the file stops being downloadable (now + retention); ignored otherwise. */
    expiresAt?: Date;
    reason?: string;
  }): Promise<boolean>;
  /** `RUNNING` -> `QUEUED` (retry, lease expiry, graceful release). */
  requeue(input: {
    exportId: string;
    leaseHolder: string | null;
    reason: string;
    restoreAttempt: boolean;
    now: Date;
  }): Promise<boolean>;
  cancel(input: {
    shopId: string;
    exportId: string;
    actor: string | null;
    reason: string;
    now: Date;
  }): Promise<ExportJobRecord | null>;
  findExpiredLeases(now: Date, limit: number): Promise<ExportJobRecord[]>;
  findUnclaimed(olderThan: Date, limit: number): Promise<ExportJobRecord[]>;
  /**
   * Takes the right to send the message of a `QUEUED` export that no worker claimed: a conditional touch of `updatedAt`
   * (still older than `olderThan`), so of two recovery runs exactly one wins.
   */
  claimResend(exportId: string, olderThan: Date, now: Date): Promise<boolean>;
  findDoneBefore(cutoff: Date, limit: number): Promise<ExportJobRecord[]>;
  markExpired(exportId: string, now: Date): Promise<boolean>;
  findFinishedBefore(cutoff: Date, limit: number): Promise<ExportJobRecord[]>;
  /** Deletes the row and its history; `true` only for the call that deleted the row (two runs count it once). */
  purge(exportId: string): Promise<boolean>;
  findActiveByShop(shopId: string): Promise<ExportJobRecord[]>;
  deleteByShop(shopId: string): Promise<{ fileKeys: string[] }>;
}

export interface ExportLinesPort {
  count(shopId: string, until: Date): Promise<number>;
  batches(
    shopId: string,
    until: Date,
    position: KeysetPosition | null,
    batchSize: number,
  ): AsyncIterable<RawExportRow[]>;
}

export interface ExportSink {
  /** Writable with backpressure; `done` resolves with the stored size once the upload completes. */
  readonly stream: Writable;
  readonly done: Promise<{ bytes: number }>;
  abort(reason?: unknown): Promise<void>;
}

export interface ExportFilesPort {
  open(key: string, options: { inactivityMs: number }): Promise<ExportSink>;
  delete(key: string): Promise<void>;
  /** Keys of every stored object under the prefix (`exports/<shopId>/` or `exports/<shopId>/<exportId>/`). */
  list(prefix: string): Promise<string[]>;
  headSize(key: string): Promise<number | null>;
  presign(input: {
    key: string;
    fileName: string;
    ttlSec: number;
  }): Promise<string>;
  /** For tests and reads of a stored object. */
  read?(key: string): Readable;
}

export interface ExportSkuInfo {
  sku: string | null;
  title: string;
}

export interface ExportSkusPort {
  /** At most 500 product ids per call; unknown ids are absent. Throws on timeout or failure. */
  lookup(
    shopId: string,
    productIds: string[],
  ): Promise<Map<string, ExportSkuInfo>>;
}

export type ExportLiveEvent =
  | {
      type: 'progress';
      rowsWritten: number;
      totalRows: number;
      bytesWritten: number;
    }
  | { type: 'done'; rowsWritten: number; bytesWritten: number }
  | { type: 'failed'; code: ExportFailureCode }
  | { type: 'cancelled' };

/** Fire-and-forget: failures are swallowed by the adapter. */
export interface ExportLivePort {
  publish(exportId: string, event: ExportLiveEvent): void;
}

export interface ExportQueuePort {
  enqueue(exportId: string, options?: { delaySeconds?: number }): Promise<void>;
}
