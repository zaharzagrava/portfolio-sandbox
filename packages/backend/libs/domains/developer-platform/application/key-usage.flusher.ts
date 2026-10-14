import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ApiKeyRepository, KeyCache } from '../domain/ports';

/**
 * Write-behind of `lastUsedAt` (FR-009): the verifier records uses in the fast store; this drains them in one atomic
 * step and stores the latest instant per key with one statement. The stored value never moves backwards (the statement
 * is conditional) and never into the future (clamped to the injected clock). When the write fails the drained records
 * are given back so the next run stores them; a lost record only leaves the value older.
 */
@Injectable()
export class KeyUsageFlusher {
  constructor(
    private readonly keys: ApiKeyRepository,
    private readonly cache: KeyCache,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async flush(): Promise<number> {
    const uses = await this.cache.drainUses();
    if (uses.length === 0) return 0;
    const ceiling = this.clock.now().getTime();
    try {
      return await this.keys.touchLastUsed(
        uses.map((u) => ({
          id: u.id,
          at: new Date(Math.min(u.at.getTime(), ceiling)),
        })),
      );
    } catch (error) {
      await this.cache.restoreUses(uses).catch(() => undefined);
      throw error;
    }
  }
}
