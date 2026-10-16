import { Injectable } from '@nestjs/common';
import {
  type ChunkRecord,
  ChunkStore,
  StorageUnavailableError,
} from '../domain/ports';
import { storageUnavailable } from '../domain/errors';
import { assetMetrics } from './asset-metrics';

const CONCURRENCY = 16;

/**
 * Whether a chunk row can be trusted as "bytes are in storage" without asking storage (S31 FR-004, research D3). A
 * referenced chunk is never cleaned up, so it is trusted; an unreferenced one is trusted only while its protection runs
 * and once storage confirmed it. Everything else is asked: that is the only place storage is called for presence.
 */
export function needsStorageCheck(row: ChunkRecord, now: Date): boolean {
  if (row.deleting) return false;
  if (row.refCount > 0) return false;
  return (
    row.storedAt === null ||
    row.protectedUntil === null ||
    row.protectedUntil.getTime() < now.getTime()
  );
}

/**
 * Asks storage, outside any transaction (FR-013), which of `hashes` exist; bounded concurrency, explicit timeouts in the
 * adapter. A storage failure or timeout is `503 storage_unavailable` and is counted (FR-014).
 */
@Injectable()
export class ChunkPresence {
  constructor(private readonly store: ChunkStore) {}

  async present(shopId: string, hashes: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < hashes.length; i += CONCURRENCY) {
      const batch = hashes.slice(i, i + CONCURRENCY);
      try {
        const answers = await Promise.all(
          batch.map(
            async (hash) =>
              [hash, await this.store.exists(shopId, hash)] as const,
          ),
        );
        for (const [hash, exists] of answers) if (exists) found.add(hash);
      } catch (error) {
        assetMetrics.storageFailures.add(1, { operation: 'head' });
        if (error instanceof StorageUnavailableError)
          throw storageUnavailable();
        throw error;
      }
    }
    return found;
  }
}
