import type { Readable } from 'node:stream';
import type { MediaPurpose } from '@marketplace-sandbox/contracts';
import type { MediaStatus } from './media-status';
import type { RejectCode } from './reject-code';
import type { Variants } from './media-urls';

/**
 * Ports of the media domain (constitution I). Nothing here imports Nest, Sequelize or `pg`: the same repository runs
 * in the Nest API, the worker and projector, and the framework-free Lambda behind a `SqlRunner`.
 */

/** Positional-parameter SQL (`$1`, `$2`, …); a transaction is whatever the supplier of the runner says it is. */
export type SqlRunner = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;

export type Actor =
  { type: 'user'; id: string } | { type: 'system' } | { type: 'worker' };

export interface MediaRecord {
  id: string;
  shopId: string | null;
  uploaderId: string;
  purpose: MediaPurpose;
  status: MediaStatus;
  originalKey: string;
  variants: Variants | null;
  width: number | null;
  height: number | null;
  rejectCode: RejectCode | null;
  attempts: number;
  leaseUntil: Date | null;
  version: number;
  uploadedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ClaimResult =
  | { outcome: 'claimed'; media: MediaRecord }
  | { outcome: 'busy' }
  | { outcome: 'skipped'; reason: 'unknown' | 'terminal' };

export interface ReadyInput {
  id: string;
  variants: Variants;
  width: number;
  height: number;
  /** Null for review photos: they are neither hashed nor candidates (FR-030). */
  hash: { dhash: string; bands: [number, number, number, number] } | null;
  duplicate: {
    mediaId: string;
    shopId: string;
    distance: number;
  } | null;
  uploadedToReadyMs: number | null;
}

export interface DuplicateScan {
  candidates: { id: string; hash: string; shopId: string }[];
  /** A band lookup that hit the cap (counted, AS-28). */
  truncatedBands: number;
}

export interface MediaRepository {
  // ---- upload
  countPending(uploaderId: string, shopId: string | null): Promise<number>;
  /** Count and insert as one atomic step (advisory lock per uploader and shop); call inside `tx`. */
  reservePending(input: {
    shopId: string | null;
    uploaderId: string;
    purpose: MediaPurpose;
    originalKey: string;
    now: Date;
    limit: number;
  }): Promise<
    { ok: true; media: MediaRecord } | { ok: false; current: number }
  >;
  insertPending(input: {
    shopId: string | null;
    uploaderId: string;
    purpose: MediaPurpose;
    originalKey: string;
    now: Date;
  }): Promise<MediaRecord>;
  findForUploader(id: string, uploaderId: string): Promise<MediaRecord | null>;
  /** `PENDING_UPLOAD → UPLOADED`; null when the photo is not in `from` any more. */
  markUploaded(
    id: string,
    actor: Actor,
    now: Date,
  ): Promise<MediaRecord | null>;
  /** `from → REJECTED` with a code; appends `media.rejected`. Null when the photo is not in `from`. */
  markRejected(input: {
    id: string;
    from: MediaStatus[];
    code: RejectCode;
    actor: Actor;
    now: Date;
  }): Promise<MediaRecord | null>;

  // ---- processing
  claim(originalKey: string, now: Date): Promise<ClaimResult>;
  /** Ends the lease early (`leaseUntil = now`) after a transient failure; the attempt stays counted. */
  releaseLease(id: string, now: Date): Promise<void>;
  /** Serialises near-duplicate scans per band value inside the READY transaction (AS-29). */
  lockBands(bands: [number, number, number, number]): Promise<void>;
  scanDuplicates(
    bands: [number, number, number, number],
    shopId: string,
    cap: number,
  ): Promise<DuplicateScan>;
  /** `PROCESSING → READY` with variants, hash and match; appends `media.ready` (+ `media.duplicate_suspected`). */
  markReady(input: ReadyInput, now: Date): Promise<MediaRecord | null>;

  // ---- reads
  findById(id: string): Promise<MediaRecord | null>;
  findForShop(id: string, shopId: string): Promise<MediaRecord | null>;
  findReadyByIds(
    ids: string[],
    filters?: { uploaderId?: string; shopId?: string; purpose?: MediaPurpose },
  ): Promise<MediaRecord[]>;

  // ---- delete and lifecycle
  /** The row `FOR UPDATE` (a concurrent gallery write waits for it). Null when unknown or `DELETED`. */
  lockById(id: string): Promise<MediaRecord | null>;
  /** `from → DELETED`; appends `media.deleted`. */
  markDeleted(input: {
    id: string;
    from: MediaStatus[];
    actor: Actor;
    now: Date;
  }): Promise<MediaRecord | null>;
  productsUsing(mediaId: string, shopId: string | null): Promise<string[]>;
  /** `PENDING_UPLOAD` older than `cutoff` → `EXPIRED` (system); returns what changed, oldest first. */
  expirePending(cutoff: Date, now: Date, limit: number): Promise<MediaRecord[]>;
  /**
   * `UPLOADED` since `uploadedBefore`, or `PROCESSING` with a lease that expired before `leaseExpiredBefore`; photos
   * touched after `touchedBefore` (re-driven a moment ago) are left alone.
   */
  findStuck(input: {
    uploadedBefore: Date;
    leaseExpiredBefore: Date;
    touchedBefore: Date;
    limit: number;
  }): Promise<MediaRecord[]>;
  /** Marks photos as re-driven (`updatedAt = now`); no transition, no version bump. */
  touch(ids: string[], now: Date): Promise<void>;
  findPurgeable(cutoff: Date, limit: number): Promise<MediaRecord[]>;
  /** Variant keys among `keys` still referenced by a photo that is not purgeable. */
  liveVariantKeys(keys: string[], excludeIds: string[]): Promise<Set<string>>;
  /** Removes a photo, its links and its history; true when a row was removed. */
  purge(id: string): Promise<boolean>;

  // ---- consumers
  /** Every non-`DELETED` photo of a shop → `DELETED` (system), one `media.deleted` each; returns the count. */
  deleteShopPhotos(shopId: string, now: Date): Promise<number>;
}

export interface GalleryRow {
  mediaId: string;
  position: number;
  variants: Variants;
  width: number | null;
  height: number | null;
}

export type AttachFailure = {
  mediaId: string;
  code: 'not_found' | 'not_ready';
};

export interface GalleryRepository {
  /** The version row, created at version 0 on first use, locked `FOR UPDATE` until the transaction ends. */
  lockVersion(productId: string, shopId: string, now: Date): Promise<number>;
  /** Classifies requested ids against the shop's own product photos (`FOR SHARE` on the rows read). */
  classify(mediaIds: string[], shopId: string): Promise<AttachFailure[]>;
  currentIds(productId: string): Promise<string[]>;
  /** Replaces the list (positions 0..n-1), bumps the version and appends `media.gallery_changed`. */
  replace(input: {
    productId: string;
    shopId: string;
    mediaIds: string[];
    version: number;
    now: Date;
  }): Promise<number>;
  /** READY photos of a product by position (what readers see). */
  readItems(productId: string): Promise<GalleryRow[]>;
  version(productId: string): Promise<number>;
  /** The items and the version from one statement, so they are one snapshot (a writer cannot land between them). */
  readSnapshot(
    productId: string,
  ): Promise<{ items: GalleryRow[]; version: number }>;
  deleteForProduct(productId: string): Promise<number>;
  deleteForShop(shopId: string): Promise<number>;
}

/** Runs `fn` in one database transaction with repositories bound to it (supplied by the Nest or Lambda adapter). */
export type Tx = <T>(
  fn: (repos: {
    media: MediaRepository;
    gallery: GalleryRepository;
  }) => Promise<T>,
) => Promise<T>;

/**
 * What the application services depend on (a DI token that is also the contract): repositories for single statements
 * and reads, and `tx` for several statements that must be atomic. Bound to Sequelize/CLS in Nest, to `pg` in the Lambda.
 */
export abstract class MediaStore {
  abstract readonly media: MediaRepository;
  abstract readonly gallery: GalleryRepository;
  abstract readonly tx: Tx;
}

export interface Blobs {
  /** Whole object as a buffer; abandoned after `timeoutMs`. */
  read(key: string, timeoutMs: number): Promise<Buffer>;
  stream(key: string, timeoutMs: number): Promise<Readable>;
  write(
    key: string,
    body: Buffer,
    contentType: string,
    options: { cacheControl: string; timeoutMs: number },
  ): Promise<void>;
  head(key: string, timeoutMs: number): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
}

/** Verdict of the malware engine; a scanner that cannot decide throws instead (the run is retried, never READY). */
export interface MalwareScannerPort {
  scan(
    source: Readable,
    options: { timeoutMs: number },
  ): Promise<{ clean: true } | { clean: false; signature: string }>;
}

export type MediaMetricName =
  | 'media_processing_total'
  | 'media_processing_seconds'
  | 'media_upload_to_ready_seconds'
  | 'media_duplicate_suspected_total'
  | 'media_duplicate_scan_truncated_total'
  | 'media_unknown_key_total'
  | 'media_scan_unavailable_total'
  | 'media_processing_attempts_exhausted_total';

export interface MediaMetrics {
  inc(
    name: MediaMetricName,
    labels?: Record<string, string>,
    by?: number,
  ): void;
  observe(
    name: MediaMetricName,
    value: number,
    labels?: Record<string, string>,
  ): void;
}

/** Structured fields only: never bytes, EXIF values, file names or full storage keys (AS-57). */
export interface MediaLogFields {
  mediaId?: string;
  result?: string;
  attempt?: number;
  durationMs?: number;
  requestId?: string;
  traceId?: string;
  [extra: string]: unknown;
}
export interface MediaLogger {
  info(message: string, fields: MediaLogFields): void;
  warn(message: string, fields: MediaLogFields): void;
  error(message: string, fields: MediaLogFields): void;
}

export const noopMetrics: MediaMetrics = { inc() {}, observe() {} };
export const noopLogger: MediaLogger = {
  info() {},
  warn() {},
  error() {},
};
