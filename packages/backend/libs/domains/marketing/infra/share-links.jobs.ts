import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { FilterRebuildService } from '../application/filter-rebuild.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'share-links.rebuild-filter': Record<string, never>;
  }
}

declareJobType({
  name: 'share-links.rebuild-filter',
  contract: z.object({}).strict(),
});

/**
 * Background work of share links, registered only by `ShareLinksWorkerModule` (S37 G9, S49 follow-up): the existence
 * filter rebuild, every six hours and once at start-up (a fresh Redis has no filter). The rebuild takes a lock, so
 * a second start is a no-op. Nothing here cancels a job.
 */
@Injectable()
export class ShareLinksJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(ShareLinksJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly rebuild: FilterRebuildService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'share-links.rebuild-filter',
        cron: '0 0 */6 * * *',
        jobType: 'share-links.rebuild-filter',
        payload: {},
        overlap: 'skip',
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(
        `schedule share-links.rebuild-filter not registered: ${error.message}`,
      );
    }
    await this.jobs
      .enqueue('share-links.rebuild-filter', {})
      .catch((error: Error) =>
        this.logger.warn(`first filter rebuild not queued: ${error.message}`),
      );
  }

  @JobHandler('share-links.rebuild-filter', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async rebuildFilter(): Promise<void> {
    await this.rebuild.rebuild();
  }
}
