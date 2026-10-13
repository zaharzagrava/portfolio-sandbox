import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { HourlyBillingService } from '../application/hourly-billing.service';
import { ReconciliationService } from '../application/reconciliation.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'ads.bill-hour': { hour?: string };
    'ads.reconcile-day': { day?: string };
  }
}

declareJobType({
  name: 'ads.bill-hour',
  contract: z
    .object({
      hour: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/)
        .optional(),
    })
    .strict(),
  maxAttempts: 5,
});
declareJobType({
  name: 'ads.reconcile-day',
  contract: z
    .object({
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .strict(),
  maxAttempts: 3,
});

/**
 * Scheduled money jobs of sponsored listings (S36, S49 follow-up): every hour at minute 5 the last closed hour is
 * charged, every day at 02:30 UTC the last closed days are reconciled. Single run across replicas (fleet concurrency 1)
 * and idempotent by the ledger reference, so a retry or an overlap never charges twice. Nothing here cancels a job.
 */
@Injectable()
export class AdsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdsJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly hourly: HourlyBillingService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.schedule('ads.bill-hour', '5 * * * *');
    await this.schedule('ads.reconcile-day', '30 2 * * *');
  }

  private async schedule(
    name: 'ads.bill-hour' | 'ads.reconcile-day',
    cron: string,
  ): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name,
        cron,
        jobType: name,
        payload: {},
        overlap: 'skip',
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule ${name} not registered: ${error.message}`);
    }
  }

  @JobHandler('ads.bill-hour', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: 600_000,
    maxRuntimeMs: 1_800_000,
  })
  async billHour(payload: { hour?: string }): Promise<void> {
    const result = await this.hourly.billHour(payload.hour);
    this.logger.log(
      `ads.bill-hour ${result.hour}: ${result.campaigns} campaigns, ${result.chargedMinor} minor units charged`,
    );
  }

  /** A source that is down is recorded `FAILED` and the job still returns normally: the next schedule retries the day. */
  @JobHandler('ads.reconcile-day', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: 600_000,
    maxRuntimeMs: 3_600_000,
  })
  async reconcileDay(payload: { day?: string }): Promise<void> {
    const results = await this.reconciliation.reconcile(payload.day);
    for (const r of results)
      this.logger.log(
        `ads.reconcile-day ${r.day}: ${r.outcome}, ${r.hoursChecked} hours checked, ${r.hoursAdjusted} adjusted`,
      );
  }
}
