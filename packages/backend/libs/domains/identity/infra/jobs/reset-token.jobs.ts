import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { ResetTokenMaintenanceService } from '../../application/reset-token-maintenance.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'auth.purge-reset-tokens': { batchSize?: number };
  }
}

declareJobType({
  name: 'auth.purge-reset-tokens',
  contract: z.object({
    batchSize: z.number().int().min(1).max(1000).optional(),
  }),
});

const BATCH = 200;
const MAX_BATCHES = 50;

/** Daily (apps/worker): deletes password-reset tokens that expired more than a day ago, in bounded batches. */
@Injectable()
export class ResetTokenJobs implements OnApplicationBootstrap {
  constructor(
    private readonly maintenance: ResetTokenMaintenanceService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'auth.purge-reset-tokens',
      cron: '30 4 * * *',
      jobType: 'auth.purge-reset-tokens',
      payload: {},
    });
  }

  @JobHandler('auth.purge-reset-tokens', { concurrency: 1 })
  async purge({ batchSize = BATCH }: { batchSize?: number }): Promise<void> {
    for (let i = 0; i < MAX_BATCHES; i++)
      if ((await this.maintenance.purgeExpired({ batchSize })) < batchSize)
        return;
  }
}
