import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import type { Blobs } from '../domain/ports';

/**
 * `Blobs` over the object-storage port. The timeouts are the callers' (read 20 s, write 10 s, scanner 15 s, run 45 s,
 * FR-020): each call is abandoned when its budget is spent, retries happen only through the queue.
 */
export class StorageBlobs implements Blobs {
  constructor(private readonly storage: ObjectStorage) {}

  async read(key: string, timeoutMs: number): Promise<Buffer> {
    const stream = await this.storage.getStream(key, { timeoutMs });
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>)
      chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  stream(key: string, timeoutMs: number) {
    return this.storage.getStream(key, { timeoutMs });
  }

  write(
    key: string,
    body: Buffer,
    contentType: string,
    options: { cacheControl: string; timeoutMs: number },
  ): Promise<void> {
    return this.storage.put(key, body, contentType, options);
  }

  head(key: string, timeoutMs: number) {
    return this.storage.head(key, { timeoutMs });
  }

  delete(key: string): Promise<void> {
    return this.storage.delete(key);
  }
}
