import { DynamicModule, Module, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JobRegistry } from './job-registry.service';
import { JobWorker } from './job-worker.service';
import { JobMaintenance } from './job-maintenance.service';
import { JobReaper } from './job-reaper.service';
import { JobsModule } from './jobs.module';
import { JobsService } from './jobs.service';
import { JOBS_WORKER_OPTIONS, JobsWorkerOptions } from './jobs-worker-options';

/**
 * Execution side - only in `apps/worker` (scaled on queue lag). Discovers
 * every @JobHandler in the app, runs the claim loop, cron materializer and
 * reaper, and registers the built-in daily partition maintenance schedule.
 */
@Module({
  imports: [DiscoveryModule, JobsModule],
  providers: [JobRegistry, JobWorker, JobReaper, JobMaintenance],
  exports: [JobWorker, JobReaper, JobMaintenance],
})
export class JobsWorkerModule implements OnApplicationBootstrap {
  constructor(private readonly jobs: JobsService) {}

  /** `JobsWorkerModule.register({ loops: false })` leaves the loops to the caller (specs). */
  static register(options: JobsWorkerOptions = {}): DynamicModule {
    return {
      module: JobsWorkerModule,
      providers: [{ provide: JOBS_WORKER_OPTIONS, useValue: options }],
    };
  }

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
