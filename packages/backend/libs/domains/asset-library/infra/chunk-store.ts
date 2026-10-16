import { Injectable, Logger } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { LIMITS } from '../domain/limits';
import { ChunkStore, StorageUnavailableError } from '../domain/ports';

/** The storage key of a chunk: derived on the server from the shop and the hash, never from client input (FR-002). */
export const chunkKey = (shopId: string, hash: string) =>
  `assets/${shopId}/chunks/${hash}`;

async function bounded<T>(
  operation: string,
  ms: number,
  call: () => Promise<T>,
  logger: Logger,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StorageUnavailableError(`${operation} timed out`)),
      ms,
    );
  });
  const running = call();
  try {
    return await Promise.race([running, timeout]);
  } catch (error) {
    running.catch(() => undefined);
    if (error instanceof StorageUnavailableError) throw error;
    // the storage message may name keys or hosts: logged here, never sent to a client
    logger.warn(`storage ${operation} failed: ${(error as Error).message}`);
    throw new StorageUnavailableError(operation);
  } finally {
    clearTimeout(timer);
  }
}

/** The `ObjectStorage` adapter of the chunk store: explicit timeouts on every call (FR-014). */
@Injectable()
export class ObjectChunkStore extends ChunkStore {
  private readonly logger = new Logger('AssetChunkStore');

  constructor(private readonly storage: ObjectStorage) {
    super();
  }

  async presignPut(
    shopId: string,
    hash: string,
    size: number,
    expiresInSec: number,
  ) {
    return this.storage.presignPutChecked(
      chunkKey(shopId, hash),
      hash,
      size,
      expiresInSec,
    );
  }

  presignGet(shopId: string, hash: string, expiresInSec: number) {
    return this.storage.presignGet(chunkKey(shopId, hash), { expiresInSec });
  }

  async exists(shopId: string, hash: string): Promise<boolean> {
    const head = await bounded(
      'head',
      LIMITS.headTimeoutMs + 500,
      () =>
        this.storage.head(chunkKey(shopId, hash), {
          timeoutMs: LIMITS.headTimeoutMs,
        }),
      this.logger,
    );
    return head !== null;
  }

  open(shopId: string, hash: string): Promise<Readable> {
    return bounded(
      'open',
      LIMITS.openTimeoutMs + 500,
      () =>
        this.storage.getStream(chunkKey(shopId, hash), {
          timeoutMs: LIMITS.openTimeoutMs,
        }),
      this.logger,
    );
  }

  remove(shopId: string, hash: string): Promise<void> {
    return bounded(
      'delete',
      LIMITS.deleteTimeoutMs,
      () => this.storage.delete(chunkKey(shopId, hash)),
      this.logger,
    );
  }
}
