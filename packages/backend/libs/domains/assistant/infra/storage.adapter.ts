import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { ObjectStore, ObjectTooLargeError, UploadGrant } from '../domain/ports';

/** Port adapter over the platform's object storage (S47 R-1): every call carries an explicit timeout (FR-041). */
@Injectable()
export class StorageAdapter implements ObjectStore {
  constructor(
    private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.storage.put(key, body, contentType, { timeoutMs: 15_000 });
  }

  head(key: string): Promise<{ size: number } | null> {
    return this.storage.head(key, { timeoutMs: 10_000 });
  }

  async read(
    key: string,
    options: { maxBytes: number; timeoutMs: number },
  ): Promise<Buffer> {
    const stream = await this.storage.getStream(key, {
      timeoutMs: options.timeoutMs,
    });
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of stream) {
      size += (part as Buffer).length;
      if (size > options.maxBytes) {
        stream.destroy();
        throw new ObjectTooLargeError();
      }
      parts.push(part as Buffer);
    }
    return Buffer.concat(parts);
  }

  delete(key: string): Promise<void> {
    return this.storage.delete(key);
  }

  async presignUpload(
    key: string,
    sha256Hex: string,
    size: number,
    ttlSeconds: number,
  ): Promise<UploadGrant> {
    const { url, headers } = await this.storage.presignPutChecked(
      key,
      sha256Hex,
      size,
      ttlSeconds,
    );
    return {
      url,
      headers,
      expiresAt: new Date(this.clock.nowMs() + ttlSeconds * 1000),
    };
  }
}
