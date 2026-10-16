import type { Readable } from 'node:stream';

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
  key: string;
  expiresAt: Date;
}

export interface MultipartUploadInit {
  uploadId: string;
  key: string;
  /** One presigned PUT URL per part (1-based part numbers). */
  partUrls: { partNumber: number; url: string }[];
}

export interface PresignPostOptions {
  key: string;
  /** Prefix condition (`image/`). Use `contentTypes` for a closed set. */
  contentTypePrefix?: string;
  /**
   * The closed set of accepted content types. A POST policy can only express "equals" or "starts with", so one type
   * becomes an exact condition and several become the longest prefix they share (the caller must still decide from
   * the bytes; S29 does).
   */
  contentTypes?: string[];
  /** Smallest accepted body (default 1). */
  minBytes?: number;
  maxBytes: number;
  expiresInSec?: number;
}

export interface StorageCallOptions {
  /** The call is abandoned (and the request aborted) after this many milliseconds. */
  timeoutMs?: number;
}

/** One part already stored for a multipart upload. */
export interface StoredPart {
  partNumber: number;
  size: number;
  etag: string;
}

export interface PutOptions extends StorageCallOptions {
  cacheControl?: string;
  /** S12: aborting stops a streamed upload, discards its parts and rejects with `StorageAbortedError`. */
  signal?: AbortSignal;
  /** S12: a streamed source that yields no bytes for this long aborts the upload and rejects with `StorageStalledError`. */
  inactivityTimeoutMs?: number;
}

export interface PresignGetOptions {
  expiresInSec?: number;
  /** Sent as `Content-Disposition: attachment; filename="..."` (RFC 6266 quoting, `filename*` for other characters). */
  downloadName?: string;
  /** Overrides the stored `Content-Type` of the response. */
  contentType?: string;
  /** Sign for the separate user-content origin (`USERCONTENT_ORIGIN`) when one is configured. */
  userContent?: boolean;
}

export class StorageAbortedError extends Error {
  readonly name = 'StorageAbortedError';
  constructor(message = 'upload aborted') {
    super(message);
  }
}

export class StorageStalledError extends Error {
  readonly name = 'StorageStalledError';
  constructor(message = 'upload source stalled') {
    super(message);
  }
}

/** RFC 6266 attachment disposition: quoted ASCII `filename`, plus `filename*` when the name has other characters. */
export function attachmentDisposition(downloadName?: string): string {
  if (!downloadName) return 'attachment';
  const fallback = downloadName.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  if (fallback === downloadName) return `attachment; filename="${fallback}"`;
  const encoded = encodeURIComponent(downloadName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** The condition a POST policy can enforce for a closed set of content types (see `PresignPostOptions`). */
export function contentTypeCondition(
  options: Pick<PresignPostOptions, 'contentTypes' | 'contentTypePrefix'>,
): ['eq' | 'starts-with', '$Content-Type', string] {
  const types = options.contentTypes ?? [];
  if (types.length === 1) return ['eq', '$Content-Type', types[0]];
  if (types.length > 1) {
    let prefix = types[0];
    for (const type of types)
      while (!type.startsWith(prefix)) prefix = prefix.slice(0, -1);
    return ['starts-with', '$Content-Type', prefix];
  }
  return ['starts-with', '$Content-Type', options.contentTypePrefix ?? ''];
}

/**
 * Bytes never flow through API servers (lesson 10/08): the API only signs,
 * clients upload/download directly to/from object storage. Port so domain
 * code and specs don't depend on S3 specifics.
 */
export abstract class ObjectStorage {
  abstract presignPost(options: PresignPostOptions): Promise<PresignedPost>;
  abstract presignGet(
    key: string,
    options?: PresignGetOptions,
  ): Promise<string>;
  /**
   * Presigned PUT whose signature covers the body's SHA-256 checksum and length:
   * S3 rejects an upload whose bytes don't match - so a key named after a hash
   * really contains those bytes (content-addressed storage, SD-25).
   */
  abstract presignPutChecked(
    key: string,
    sha256Hex: string,
    contentLength: number,
    expiresInSec?: number,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  abstract createMultipartUpload(
    key: string,
    contentType: string,
    parts: number,
    expiresInSec?: number,
  ): Promise<MultipartUploadInit>;
  abstract completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
    options?: StorageCallOptions,
  ): Promise<void>;
  abstract abortMultipartUpload(
    key: string,
    uploadId: string,
    options?: StorageCallOptions,
  ): Promise<void>;
  /** Opens a multipart upload without signing any part (S30: parts are signed one by one with an exact length). */
  abstract startMultipartUpload(
    key: string,
    contentType: string,
    options?: StorageCallOptions,
  ): Promise<{ uploadId: string }>;
  /**
   * Presigned `UploadPart` URL whose signature covers the body length: storage refuses a body one byte longer or
   * shorter, and a URL of one part cannot store another part's bytes.
   */
  abstract presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
    expiresInSec?: number,
  ): Promise<string>;
  /** The parts storage holds for an upload (all pages), or `null` when the upload no longer exists. */
  abstract listParts(
    key: string,
    uploadId: string,
    options?: StorageCallOptions,
  ): Promise<StoredPart[] | null>;
  abstract getStream(
    key: string,
    options?: StorageCallOptions,
  ): Promise<Readable>;
  abstract put(
    key: string,
    body: Buffer | Readable,
    contentType: string,
    options?: PutOptions,
  ): Promise<void>;
  abstract head(
    key: string,
    options?: StorageCallOptions,
  ): Promise<{
    size: number;
    contentType?: string;
    cacheControl?: string;
  } | null>;
  abstract delete(key: string): Promise<void>;
  /** Removes up to `limit` objects under `prefix` (default 1000); returns how many were removed. Missing is fine. */
  abstract deletePrefix(
    prefix: string,
    options?: StorageCallOptions & { limit?: number },
  ): Promise<number>;
  /** Objects whose key starts with `prefix`, with their last-modified instant (all pages). */
  abstract list(
    prefix: string,
  ): Promise<{ key: string; lastModified: Date; size: number }[]>;
}
