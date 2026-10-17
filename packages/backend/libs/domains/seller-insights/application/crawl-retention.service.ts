import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  TARGET_REPOSITORY,
  type TargetRepository,
} from '../domain/crawler-ports';
import { RETIRED_RETENTION_MS } from './crawl.constants';

const BATCH = 500;

/**
 * Daily purge (S41 FR-032): targets retired 30 days ago that still have no watch are deleted, in batches that skip
 * rows another replica holds, so two runs never delete a row twice. History (2 years) and the archive (7 days) expire
 * by their stores' own rules.
 */
@Injectable()
export class CrawlRetentionService {
  constructor(
    @Inject(TARGET_REPOSITORY) private readonly targets: TargetRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async purge(): Promise<number> {
    const before = new Date(this.clock.nowMs() - RETIRED_RETENTION_MS);
    let total = 0;
    for (;;) {
      const deleted = await this.targets.purgeRetired(before, BATCH);
      total += deleted;
      if (deleted < BATCH) return total;
    }
  }
}
