import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { VideoLifecycleService } from './application/video-lifecycle.service';
import { VideoPurgeService } from './application/video-purge.service';
import { VideoSweepService } from './application/video-sweep.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'media.video-expire-uploads': Record<string, never>;
    'media.video-requeue-stuck': Record<string, never>;
    'media.video-purge': Record<string, never>;
  }
}

for (const name of [
  'media.video-expire-uploads',
  'media.video-requeue-stuck',
  'media.video-purge',
] as const)
  declareJobType({ name, contract: z.object({}).strict() });

/** Cron with seconds (S49): every 5 minutes, every minute, every 5 minutes (a deleted video's files go within 5 minutes). */
const SCHEDULES = [
  { name: 'media.video-expire-uploads', cron: '0 */5 * * * *' },
  { name: 'media.video-requeue-stuck', cron: '0 * * * * *' },
  { name: 'media.video-purge', cron: '0 */5 * * * *' },
] as const;

/**
 * The three maintenance jobs of video (S30 R-24), registered only by `VideoWorkerModule`. Each handler runs one bounded
 * batch; single-run across replicas is the job scheduler's lease (S49), and each is idempotent anyway. A schedule the
 * scheduler refuses is caught as `InvalidScheduleError` and logged. Nothing here cancels a job.
 */
@Injectable()
export class VideoMaintenanceJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideoMaintenanceJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly lifecycle: VideoLifecycleService,
    private readonly sweep: VideoSweepService,
    private readonly purge: VideoPurgeService,
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

  @JobHandler('media.video-expire-uploads', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async expireUploads(): Promise<void> {
    await this.lifecycle.expireUploads();
  }

  @JobHandler('media.video-requeue-stuck', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async requeueStuck(): Promise<void> {
    await this.sweep.sweep();
  }

  @JobHandler('media.video-purge', { concurrency: 1, fleetConcurrency: 1 })
  async purgeFiles(): Promise<void> {
    await this.purge.purge();
  }
}
