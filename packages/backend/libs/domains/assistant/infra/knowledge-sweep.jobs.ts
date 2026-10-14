import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import {
  InvalidScheduleError,
  JobsService,
  declareJobType,
} from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { SweepReport, SweepService } from '../application/sweep.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'knowledge.sweep': Record<string, never>;
  }
}

declareJobType({
  name: 'knowledge.sweep',
  contract: z.object({}).strict(),
});

/**
 * The repair pass of the knowledge documents (apps/worker, S47 FR-011): every five minutes, one run in the whole fleet
 * (S49 claims the schedule tick once), idempotent by construction (see `SweepService`).
 */
@Injectable()
export class KnowledgeSweepJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(KnowledgeSweepJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly sweep: SweepService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'knowledge.sweep',
        cron: '0 */5 * * * *',
        jobType: 'knowledge.sweep',
        payload: {},
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule not registered: ${error.message}`);
    }
  }

  @JobHandler('knowledge.sweep', { concurrency: 1, fleetConcurrency: 1 })
  run(): Promise<SweepReport> {
    return this.sweep.run();
  }
}
