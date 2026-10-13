import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { MaintenanceService } from './application/maintenance.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'media.expire-pending-uploads': Record<string, never>;
    'media.requeue-stuck': Record<string, never>;
    'media.purge': Record<string, never>;
  }
}

for (const name of [
  'media.expire-pending-uploads',
  'media.requeue-stuck',
  'media.purge',
] as const)
  declareJobType({ name, contract: z.object({}).strict() });

/** Cron with seconds (S49): every 5 minutes, every minute, every hour. */
const SCHEDULES = [
  { name: 'media.expire-pending-uploads', cron: '0 */5 * * * *' },
  { name: 'media.requeue-stuck', cron: '0 * * * * *' },
  { name: 'media.purge', cron: '0 0 * * * *' },
] as const;

/**
 * The three maintenance jobs of photos (S29 FR-062–FR-064), registered only by `MediaWorkerModule`. Each handler runs
 * one bounded batch; single-run across replicas is the job scheduler's lease (S49), and each is idempotent anyway.
 * Nothing here cancels a job.
 */
@Injectable()
export class MediaMaintenanceJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(MediaMaintenanceJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly maintenance: MaintenanceService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const schedule of SCHEDULES) {
      try {
        await this.jobs.upsertSchedule({
          name: schedule.name,
          cron: schedule.cron,
          jobType: schedule.name,
          payload: {},
          overlap: 'skip',
        });
      } catch (error) {
        if (!(error instanceof InvalidScheduleError)) throw error;
        this.logger.error(
          `schedule ${schedule.name} not registered: ${error.message}`,
        );
      }
    }
  }

  @JobHandler('media.expire-pending-uploads', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async expirePendingUploads(): Promise<void> {
    await this.maintenance.expirePendingUploads();
  }

  @JobHandler('media.requeue-stuck', { concurrency: 1, fleetConcurrency: 1 })
  async requeueStuck(): Promise<void> {
    await this.maintenance.requeueStuck();
  }

  @JobHandler('media.purge', { concurrency: 1, fleetConcurrency: 1 })
  async purge(): Promise<void> {
    await this.maintenance.purge();
  }
}
