import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { StoreDeadLetterWatcher } from '../application/store-dead-letter-watcher.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'analytics.watch-dead-letters': Record<string, never>;
  }
}

declareJobType({
  name: 'analytics.watch-dead-letters',
  contract: z.object({}).strict(),
});

/**
 * Background work of analytics, registered only by `AnalyticsWorkerModule`: count the store's new dead letters every 30
 * seconds, one run at a time across the fleet, so each row is counted once.
 */
@Injectable()
export class AnalyticsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(AnalyticsJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly watcher: StoreDeadLetterWatcher,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'analytics.watch-dead-letters',
        cron: '*/30 * * * * *',
        jobType: 'analytics.watch-dead-letters',
        payload: {},
        overlap: 'skip',
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(
        `schedule analytics.watch-dead-letters not registered: ${error.message}`,
      );
    }
  }

  @JobHandler('analytics.watch-dead-letters', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async watchDeadLetters(): Promise<void> {
    await this.watcher.poll();
  }
}
