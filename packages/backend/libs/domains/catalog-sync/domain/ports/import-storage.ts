import type { Readable } from 'node:stream';

export const IMPORT_STORAGE = Symbol('IMPORT_STORAGE');

export interface ImportStoredPart {
  partNumber: number;
  etag: string;
  size: number;
}

/** The source file is gone from storage (removed by the backstop rule or by hand). */
export class ImportSourceMissingError extends Error {
  constructor() {
    super('import source is missing');
    this.name = 'ImportSourceMissingError';
  }
}

/**
 * Storage of the import's files (data-model.md, Storage layout). On the delete paths a missing object or an unknown
 * upload is not an error (L-016).
 */
export interface ImportStoragePort {
  startUpload(key: string): Promise<{ uploadHandle: string }>;
  signPart(
    key: string,
    uploadHandle: string,
    partNumber: number,
    length: number,
  ): Promise<string>;
  /** `null` when the upload no longer exists. */
  listParts(
    key: string,
    uploadHandle: string,
  ): Promise<ImportStoredPart[] | null>;
  completeUpload(
    key: string,
    uploadHandle: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void>;
  /** Unknown upload = success. */
  abortUpload(key: string, uploadHandle: string): Promise<void>;
  headSize(key: string): Promise<number | null>;
  /** The object from `startByte` on; throws `ImportSourceMissingError` when it does not exist. */
  openSource(
    key: string,
    startByte: number,
    signal?: AbortSignal,
  ): Promise<Readable>;
  deleteObject(key: string): Promise<void>;
  /** The error lines of one batch (no header); a redone batch replaces its part. */
  putReportPart(
    shopId: string,
    importId: string,
    batch: number,
    lines: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Header + all parts in batch order into `errors.csv`, then the parts are deleted; `null` when there is nothing to report. */
  finaliseReport(
    shopId: string,
    importId: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
  signReportDownload(
    key: string,
    downloadName: string,
  ): Promise<{ url: string; expiresAt: Date }>;
  /** Removes everything under the prefix, repeatedly until it is empty. */
  deletePrefix(prefix: string): Promise<void>;
}
