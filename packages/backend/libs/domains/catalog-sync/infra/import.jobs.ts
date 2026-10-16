import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import {
  InvalidScheduleError,
  JobsService,
  declareJobType,
} from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { ImportLifecycleService } from '../application/import-lifecycle.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'catalog-sync.recover-stalled-imports': Record<string, never>;
    'catalog-sync.expire-pending-imports': Record<string, never>;
    'catalog-sync.purge-imports': Record<string, never>;
  }
}

for (const name of [
  'catalog-sync.recover-stalled-imports',
  'catalog-sync.expire-pending-imports',
  'catalog-sync.purge-imports',
] as const)
  declareJobType({ name, contract: z.object({}).strict() });

/**
 * Recurring jobs of the bulk import (run in the worker app; single-run and idempotent: every step is a conditional
 * statement or an idempotent delete, so two instances change nothing twice). `JobsService.cancel` is never called. An
 * invalid schedule is a programming error: the worker fails to start instead of running without recovery, expiry or
 * retention.
 */
@Injectable()
export class ImportJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(ImportJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly lifecycle: ImportLifecycleService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'catalog-sync.recover-stalled-imports',
        cron: '0 * * * * *',
        jobType: 'catalog-sync.recover-stalled-imports',
        payload: {},
      });
      await this.jobs.upsertSchedule({
        name: 'catalog-sync.expire-pending-imports',
        cron: '0 */5 * * * *',
        jobType: 'catalog-sync.expire-pending-imports',
        payload: {},
      });
      await this.jobs.upsertSchedule({
        name: 'catalog-sync.purge-imports',
        cron: '0 20 3 * * *',
        jobType: 'catalog-sync.purge-imports',
        payload: {},
      });
    } catch (error) {
      if (error instanceof InvalidScheduleError)
        throw new Error(
          `catalog-sync import schedule is invalid: ${error.message}`,
          { cause: error },
        );
      throw error;
    }
  }

  /** Imports whose message was lost or whose lease ran out are put back on the queue (FR-028, AS-40). */
  @JobHandler('catalog-sync.recover-stalled-imports', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  recover(): Promise<{ enqueued: number }> {
    return this.lifecycle.recoverStalled();
  }

  /** Abandoned uploads expire after 24 hours (FR-007, AS-59). */
  @JobHandler('catalog-sync.expire-pending-imports', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  expire(): Promise<{ expired: number }> {
    return this.lifecycle.expirePending();
  }

  /** Reports after 30 days, records after 90, at most 500 per run (FR-043, AS-67). */
  @JobHandler('catalog-sync.purge-imports', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async purge(): Promise<{ records: number; reports: number }> {
    const result = await this.lifecycle.purge();
    this.logger.log({ action: 'import.purge_run', ...result });
    return result;
  }
}
