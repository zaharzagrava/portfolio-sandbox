import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { BulkJobRepository } from '../domain/ports';

export const PURGE_BATCH = 500;

/** Deletes bulk jobs and their chunks 7 days after creation, at most 500 jobs per statement (FR-047). */
@Injectable()
export class BulkPurger {
  constructor(
    private readonly jobs: BulkJobRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async purge(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.jobs.purgeExpired(this.clock.now(), PURGE_BATCH);
      total += n;
      if (n < PURGE_BATCH) return total;
    }
  }
}
