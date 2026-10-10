import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { IdempotencyRepository } from './idempotency.repository';

import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'platform.purge-idempotency-keys': Record<string, never>;
  }
}

declareJobType({
  name: 'platform.purge-idempotency-keys',
  contract: z.object({}),
});

export const PURGE_JOB_NAME = 'platform.purge-idempotency-keys';
const BATCH_SIZE = 1000;

/**
 * Body of the `platform.purge-idempotency-keys` job (S49 registry): removes records whose TTL plus 1 h retention is over,
 * in batches of at most 1 000. The schedule is registered when the job system is part of the app.
 */
@Injectable()
export class IdempotencyPurgeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdempotencyPurgeService.name);

  constructor(
    private readonly repository: IdempotencyRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly jobs?: JobsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.jobs?.upsertSchedule({
      name: PURGE_JOB_NAME,
      cron: '*/15 * * * *',
      jobType: PURGE_JOB_NAME,
      payload: {},
    });
  }

  /** Deletes one batch of at most 1 000 records; returns how many went. */
  purgeBatch(): Promise<number> {
    return this.repository.purge(BATCH_SIZE, this.clock.now());
  }

  /** Runs batches until none is left; returns the total removed. */
  @JobHandler(PURGE_JOB_NAME, { concurrency: 1 })
  async run(): Promise<number> {
    let total = 0;
    for (;;) {
      const removed = await this.purgeBatch();
      total += removed;
      if (removed < BATCH_SIZE) break;
    }
    if (total > 0) this.logger.log(`purged ${total} idempotency records`);
    return total;
  }
}
