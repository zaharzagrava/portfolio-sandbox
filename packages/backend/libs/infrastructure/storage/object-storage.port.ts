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
  contentTypePrefix: string;
  maxBytes: number;
  expiresInSec?: number;
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
    options?: { expiresInSec?: number; downloadName?: string },
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
  ): Promise<void>;
  abstract abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  abstract getStream(key: string): Promise<Readable>;
  abstract put(
    key: string,
    body: Buffer | Readable,
    contentType: string,
  ): Promise<void>;
  abstract head(
    key: string,
  ): Promise<{ size: number; contentType?: string } | null>;
  abstract delete(key: string): Promise<void>;
}
