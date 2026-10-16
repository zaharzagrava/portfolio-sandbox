import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { CleanupService } from '../application/cleanup.service';
import '../application/asset.job-types';

/**
 * The four scheduled jobs of S31 (FR-050). Each handler is idempotent and claims its work with `FOR UPDATE SKIP LOCKED`
 * or deletes by a condition, so two runs at once do the work once and a repeat changes nothing (AS-75). The work itself
 * is the cleanup service's.
 */
@Injectable()
export class AssetsJobs {
  constructor(private readonly cleanup: CleanupService) {}

  @JobHandler('assets.gc-chunks', { concurrency: 1 })
  async gcChunks(): Promise<void> {
    await this.cleanup.collectChunks();
    await this.cleanup.reportStorage();
  }

  @JobHandler('assets.purge-deleted-assets', { concurrency: 1 })
  async purgeDeletedAssets(): Promise<void> {
    await this.cleanup.purgeDeletedAssets();
  }

  @JobHandler('assets.purge-download-grants', { concurrency: 1 })
  async purgeDownloadGrants(): Promise<void> {
    await this.cleanup.purgeDownloadGrants();
  }

  @JobHandler('assets.purge-changes', { concurrency: 1 })
  async purgeChanges(): Promise<void> {
    await this.cleanup.purgeChanges();
  }
}

const SCHEDULES = [
  { name: 'assets.gc-chunks', cron: '17 * * * *' },
  { name: 'assets.purge-deleted-assets', cron: '23 3 * * *' },
  { name: 'assets.purge-download-grants', cron: '29 3 * * *' },
  { name: 'assets.purge-changes', cron: '41 3 * * *' },
] as const;

/** Upserts the schedules at start (S49 keeps one run per schedule across replicas). */
@Injectable()
export class AssetsSchedule implements OnApplicationBootstrap {
  constructor(private readonly jobs: JobsService) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const { name, cron } of SCHEDULES)
      await this.jobs.upsertSchedule({
        name,
        cron,
        jobType: name,
        payload: {},
      });
  }
}
