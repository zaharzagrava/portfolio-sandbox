import { Readable } from 'node:stream';
import {
  contentTypeCondition,
  MultipartUploadInit,
  ObjectStorage,
  PresignedPost,
  PresignPostOptions,
  PutOptions,
  StorageCallOptions,
  StoredPart,
} from './object-storage.port';

/** Test double: keeps objects in a Map, returns fake but well-formed signed URLs. */
export class InMemoryObjectStorage extends ObjectStorage {
  readonly objects = new Map<
    string,
    {
      body: Buffer;
      contentType: string;
      modifiedAt: Date;
      cacheControl?: string;
    }
  >();

  presignPost({
    key,
    contentTypePrefix,
    contentTypes,
    minBytes = 1,
    maxBytes,
    expiresInSec = 600,
  }: PresignPostOptions): Promise<PresignedPost> {
    const [, , contentType] = contentTypeCondition({
      contentTypes,
      contentTypePrefix,
    });
    return Promise.resolve({
      url: 'http://storage.test/upload',
      fields: {
        key,
        'Content-Type': contentType,
        policy: `min=${minBytes};max=${maxBytes}`,
      },
      key,
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    });
  }

  async presignPutChecked(
    key: string,
    sha256Hex: string,
    contentLength: number,
  ) {
    return {
      url: `http://storage.test/${encodeURIComponent(key)}?put=1`,
      headers: {
        'x-amz-checksum-sha256': Buffer.from(sha256Hex, 'hex').toString(
          'base64',
        ),
        'content-length': String(contentLength),
      },
    };
  }

  async presignGet(key: string) {
    return `http://storage.test/${encodeURIComponent(key)}?sig=fake`;
  }

  async createMultipartUpload(
    key: string,
    _contentType: string,
    parts: number,
  ): Promise<MultipartUploadInit> {
    return {
      uploadId: `upload-${key}`,
      key,
      partUrls: Array.from({ length: parts }, (_, i) => ({
        partNumber: i + 1,
        url: `http://storage.test/${key}?part=${i + 1}`,
      })),
    };
  }

  /** Parts of open multipart uploads, keyed by upload id (test double only; tests may fill it). */
  readonly parts = new Map<string, Map<number, Buffer>>();

  startMultipartUpload(
    key: string,
    _contentType?: string,
  ): Promise<{ uploadId: string }> {
    const uploadId = `upload-${key}-${this.parts.size + 1}`;
    this.parts.set(uploadId, new Map());
    return Promise.resolve({ uploadId });
  }

  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
  ): Promise<string> {
    return Promise.resolve(
      `http://storage.test/${encodeURIComponent(key)}?uploadId=${encodeURIComponent(uploadId)}&part=${partNumber}&len=${contentLength}`,
    );
  }

  listParts(_key: string, uploadId: string): Promise<StoredPart[] | null> {
    const held = this.parts.get(uploadId);
    if (!held) return Promise.resolve(null);
    return Promise.resolve(
      [...held.entries()]
        .sort(([a], [b]) => a - b)
        .map(([partNumber, body]) => ({
          partNumber,
          size: body.length,
          etag: `"${partNumber}-${body.length}"`,
        })),
    );
  }

  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[] = [],
  ): Promise<void> {
    const held = this.parts.get(uploadId);
    if (held) {
      const bodies = [...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => held.get(p.partNumber) ?? Buffer.alloc(0));
      this.objects.set(key, {
        body: Buffer.concat(bodies),
        contentType: 'application/octet-stream',
        modifiedAt: new Date(),
      });
      this.parts.delete(uploadId);
    }
    return Promise.resolve();
  }

  abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.parts.delete(uploadId);
    return Promise.resolve();
  }

  deletePrefix(
    prefix: string,
    options: StorageCallOptions & { limit?: number } = {},
  ): Promise<number> {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .slice(0, options.limit ?? 1000);
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve(keys.length);
  }

  async getStream(key: string) {
    const obj = this.objects.get(key);
    if (!obj)
      throw Object.assign(new Error(`NoSuchKey ${key}`), { name: 'NoSuchKey' });
    return Readable.from(obj.body);
  }

  async put(
    key: string,
    body: Buffer | Readable,
    contentType: string,
    options: PutOptions = {},
  ) {
    const buffer = Buffer.isBuffer(body)
      ? body
      : Buffer.concat(await body.toArray());
    this.objects.set(key, {
      body: buffer,
      contentType,
      modifiedAt: new Date(),
      cacheControl: options.cacheControl,
    });
  }

  head(key: string, _options?: StorageCallOptions) {
    const obj = this.objects.get(key);
    return Promise.resolve(
      obj
        ? {
            size: obj.body.length,
            contentType: obj.contentType,
            ...(obj.cacheControl && { cacheControl: obj.cacheControl }),
          }
        : null,
    );
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  list(prefix: string) {
    return Promise.resolve(
      [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, o]) => ({
          key,
          lastModified: o.modifiedAt,
          size: o.body.length,
        })),
    );
  }
}
