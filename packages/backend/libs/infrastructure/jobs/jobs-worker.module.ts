import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JobRegistry } from './job-registry.service';
import { JobWorker } from './job-worker.service';
import { JobMaintenance } from './job-maintenance.service';
import { JobsModule } from './jobs.module';
import { JobsService } from './jobs.service';

/**
 * Execution side - only in `apps/worker` (scaled on queue lag). Discovers
 * every @JobHandler in the app, runs the claim loop, cron materializer and
 * reaper, and registers the built-in daily partition maintenance schedule.
 */
@Module({
  imports: [DiscoveryModule, JobsModule],
  providers: [JobRegistry, JobWorker, JobMaintenance],
  exports: [JobWorker, JobMaintenance],
})
export class JobsWorkerModule implements OnApplicationBootstrap {
  constructor(private readonly jobs: JobsService) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'jobs.partition-maintenance',
      cron: '15 3 * * *',
      timezone: 'UTC',
      jobType: 'jobs.partition-maintenance',
      payload: {},
    });
  }
}
