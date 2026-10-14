import { Injectable } from '@nestjs/common';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import type { RunningExperiment } from '../domain/experiment-types';
import type { RunningSetCache } from '../domain/ports';

export const RUNNING_SET_KEY = 'experiments:running';
const SHARED_TTL_MS = 30_000;
/** The cache toolkit caps the in-process layer at 5 s, which keeps the staleness bound (15 s) with room to spare. */
const MEMORY_TTL_MS = 5_000;

/**
 * The running experiments for assignment (S39 FR-031): this instance's memory over the shared cache over the database.
 * A write invalidates the shared key (and every instance's memory through the toolkit's broadcast); an instance that
 * missed the broadcast still reloads within `MEMORY_TTL_MS`. A cache that cannot be read falls through to the loader
 * (the toolkit degrades by itself), so only the loader's own failure reaches the caller.
 */
@Injectable()
export class CacheRunningSet implements RunningSetCache {
  constructor(private readonly cache: CacheService) {}

  async get(
    loader: () => Promise<RunningExperiment[]>,
  ): Promise<RunningExperiment[]> {
    const running = await this.cache.getOrLoad<RunningExperiment[]>(
      RUNNING_SET_KEY,
      loader,
      { ttlMs: SHARED_TTL_MS, l1: 'always', l1TtlMs: MEMORY_TTL_MS },
    );
    return running ?? [];
  }

  async invalidate(): Promise<void> {
    try {
      await this.cache.invalidate([RUNNING_SET_KEY]);
    } catch {
      // The repair path must survive the failure it repairs (L-016): the entry expires by itself within its TTL.
    }
  }
}
