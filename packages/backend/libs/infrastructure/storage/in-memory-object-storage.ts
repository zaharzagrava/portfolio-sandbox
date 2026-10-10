import { Readable } from 'node:stream';
import {
  MultipartUploadInit,
  ObjectStorage,
  PresignedPost,
  PresignPostOptions,
} from './object-storage.port';

/** Test double: keeps objects in a Map, returns fake but well-formed signed URLs. */
export class InMemoryObjectStorage extends ObjectStorage {
  readonly objects = new Map<
    string,
    { body: Buffer; contentType: string; modifiedAt: Date }
  >();

  async presignPost({
    key,
    contentTypePrefix,
    maxBytes,
    expiresInSec = 600,
  }: PresignPostOptions): Promise<PresignedPost> {
    return {
      url: 'http://storage.test/upload',
      fields: {
        key,
        'Content-Type': contentTypePrefix,
        policy: `max=${maxBytes}`,
      },
      key,
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    };
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

  async completeMultipartUpload() {}
  async abortMultipartUpload() {}

  async getStream(key: string) {
    const obj = this.objects.get(key);
    if (!obj)
      throw Object.assign(new Error(`NoSuchKey ${key}`), { name: 'NoSuchKey' });
    return Readable.from(obj.body);
  }

  async put(key: string, body: Buffer | Readable, contentType: string) {
    const buffer = Buffer.isBuffer(body)
      ? body
      : Buffer.concat(await body.toArray());
    this.objects.set(key, {
      body: buffer,
      contentType,
      modifiedAt: new Date(),
    });
  }

  async head(key: string) {
    const obj = this.objects.get(key);
    return obj ? { size: obj.body.length, contentType: obj.contentType } : null;
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
