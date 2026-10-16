import { Readable } from 'node:stream';
import {
  attachmentDisposition,
  contentTypeCondition,
  MultipartUploadInit,
  ObjectStorage,
  PresignedPost,
  PresignGetOptions,
  PresignPostOptions,
  PutOptions,
  StorageAbortedError,
  StorageCallOptions,
  StorageStalledError,
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

  presignGet(key: string, options: PresignGetOptions = {}): Promise<string> {
    const query = new URLSearchParams({ sig: 'fake' });
    if (options.downloadName)
      query.set(
        'response-content-disposition',
        attachmentDisposition(options.downloadName),
      );
    if (options.contentType)
      query.set('response-content-type', options.contentType);
    const base = options.userContent
      ? 'http://usercontent.storage.test'
      : 'http://storage.test';
    return Promise.resolve(
      `${base}/${encodeURIComponent(key)}?${query.toString()}`,
    );
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

  getStream(key: string, options: { start?: number } = {}) {
    const obj = this.objects.get(key);
    if (!obj)
      return Promise.reject(
        Object.assign(new Error(`NoSuchKey ${key}`), { name: 'NoSuchKey' }),
      );
    const start = options.start ?? 0;
    if (start >= obj.body.length) return Promise.resolve(Readable.from([]));
    // 64 KiB chunks, like a network stream: a reader that stops early leaves the rest unread
    const body = start > 0 ? obj.body.subarray(start) : obj.body;
    return Promise.resolve(
      Readable.from(
        (function* () {
          for (let at = 0; at < body.length; at += 65_536)
            yield body.subarray(at, at + 65_536);
        })(),
      ),
    );
  }

  async put(
    key: string,
    body: Buffer | Readable,
    contentType: string,
    options: PutOptions = {},
  ) {
    if (options.signal?.aborted) {
      if (!Buffer.isBuffer(body)) body.destroy();
      throw new StorageAbortedError();
    }
    const buffer = Buffer.isBuffer(body)
      ? body
      : await this.stageStream(key, body, options);
    this.objects.set(key, {
      body: buffer,
      contentType,
      modifiedAt: new Date(),
      cacheControl: options.cacheControl,
    });
  }

  /** Stages a stream as one part of a multipart upload; on abort or stall the upload is aborted and its parts dropped. */
  private async stageStream(
    key: string,
    body: Readable,
    options: PutOptions,
  ): Promise<Buffer> {
    const { uploadId } = await this.startMultipartUpload(key);
    const chunks: Buffer[] = [];
    let fail: (error: Error) => void = () => undefined;
    const failed = new Promise<never>((_, reject) => {
      fail = reject;
    });
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      if (!options.inactivityTimeoutMs) return;
      clearTimeout(timer);
      timer = setTimeout(
        () => fail(new StorageStalledError()),
        options.inactivityTimeoutMs,
      );
    };
    const onAbort = () => fail(new StorageAbortedError());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const read = (async () => {
      arm();
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk as Buffer));
        this.parts.get(uploadId)?.set(chunks.length, chunks[chunks.length - 1]);
        arm();
      }
    })();
    try {
      await Promise.race([read, failed]);
      const whole = Buffer.concat(chunks);
      this.parts.delete(uploadId);
      return whole;
    } catch (error) {
      body.destroy();
      read.catch(() => undefined);
      await this.abortMultipartUpload(key, uploadId);
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
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
