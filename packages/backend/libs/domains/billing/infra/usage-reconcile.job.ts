import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import '../application/billing.job-types';
import { UsageReconcileService } from '../application/usage-reconcile.service';

/** The daily ledger check: 03:15 UTC, one run per slot across replicas (S49 claiming), lease 600 s. */
export const USAGE_RECONCILE_SCHEDULE = {
  name: 'billing.usage-reconcile',
  cron: '15 3 * * *',
  timezone: 'UTC',
} as const;

/**
 * Thin handler (I.2): one call to the reconciliation. The schedule is registered at boot (idempotent upsert, safe from
 * every replica); an invalid schedule is logged and does not stop the worker, whose other jobs must keep running.
 */
@Injectable()
export class UsageReconcileJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(UsageReconcileJob.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly reconcile: UsageReconcileService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        ...USAGE_RECONCILE_SCHEDULE,
        jobType: 'billing.usage-reconcile',
        payload: {},
        overlap: 'skip',
        maxAttempts: 1,
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(
        `the usage reconciliation schedule is invalid (${error.field}); it will not run`,
      );
    }
  }

  @JobHandler('billing.usage-reconcile', { concurrency: 1, leaseMs: 600_000 })
  async run(): Promise<void> {
    const { examined, drift } = await this.reconcile.run();
    this.logger.log(
      `usage reconciliation: ${examined} row(s) examined, ${drift} with drift`,
    );
  }
}
