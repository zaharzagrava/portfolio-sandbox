import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { UsageBucketRepository } from '../domain/ports';

export const CLOSE_AFTER_MS = 65_000;
export const CLOSE_BATCH = 500;

/**
 * Emits `usage.recorded` for every minute that closed at least 5 s ago (research R-08): at most 500 buckets per
 * transaction, each marked emitted in the transaction that writes its event, with a deterministic event id.
 */
@Injectable()
export class UsageCloser {
  constructor(
    private readonly buckets: UsageBucketRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async close(): Promise<number> {
    let total = 0;
    for (;;) {
      const now = this.clock.now();
      const n = await this.buckets.emitClosed({
        closedBefore: new Date(now.getTime() - CLOSE_AFTER_MS),
        limit: CLOSE_BATCH,
        now,
      });
      total += n;
      if (n < CLOSE_BATCH) return total;
    }
  }
}
