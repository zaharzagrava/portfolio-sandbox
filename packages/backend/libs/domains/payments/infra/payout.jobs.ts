import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { NonRetryableJobError } from '@app/infrastructure/jobs/job-types';
import type { JobContext } from '@app/infrastructure/jobs/job-types';
import '../application/payout.job-types';
import { PayoutAuditService } from '../application/payout-audit.service';
import { PayoutResolverService } from '../application/payout-resolver.service';
import { PayoutRunService } from '../application/payout-run.service';
import { PayoutTransferService } from '../application/payout-transfer.service';
import { RunRefused } from '../domain/payout-errors';
import { upsertLedgerSchedule } from './schedule-bootstrap';

const RESOLVE_BATCH = 50;

/**
 * Thin job handlers of the payouts (S15 contracts/events.md "Jobs"): parse, call one use case, map the result. No
 * transaction, ledger call or provider call lives here.
 */
@Injectable()
export class PayoutJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(PayoutJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly run: PayoutRunService,
    private readonly transfers: PayoutTransferService,
    private readonly resolver: PayoutResolverService,
    private readonly audit: PayoutAuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await upsertLedgerSchedule(this.jobs, this.logger, {
      name: 'payouts.run-weekly',
      cron: '0 6 * * 1',
      timezone: 'Europe/Warsaw',
      jobType: 'payouts.run-weekly',
      payload: {},
    });
    await upsertLedgerSchedule(this.jobs, this.logger, {
      name: 'payouts.resolve-in-doubt',
      cron: '* * * * *',
      jobType: 'payouts.resolve-in-doubt',
      payload: {},
    });
    await upsertLedgerSchedule(this.jobs, this.logger, {
      name: 'payouts.audit-daily',
      cron: '20 3 * * *',
      jobType: 'payouts.audit-daily',
      payload: {},
    });
  }

  @JobHandler('payouts.run-weekly', {
    fleetConcurrency: 1,
    concurrency: 1,
    leaseMs: 600_000,
  })
  async runWeekly(
    payload: { periodStart?: string },
    ctx: JobContext,
  ): Promise<void> {
    try {
      await this.run.run({
        periodStart: payload.periodStart,
        signal: ctx.signal,
      });
    } catch (error) {
      // A refused period can never succeed: the job goes dead instead of retrying.
      if (error instanceof RunRefused)
        throw new NonRetryableJobError('period_invalid');
      throw error;
    }
  }

  @JobHandler('payouts.send', { concurrency: 8 })
  async send(payload: { payoutId: string }, ctx: JobContext): Promise<void> {
    await this.transfers.send(payload.payoutId, {
      attempt: ctx.attempt,
      isLastAttempt: ctx.isLastAttempt,
    });
  }

  @JobHandler('payouts.resolve-in-doubt', {
    fleetConcurrency: 1,
    concurrency: 1,
  })
  async resolveInDoubt(): Promise<void> {
    await this.resolver.resolveDue(RESOLVE_BATCH);
  }

  @JobHandler('payouts.audit-daily', { fleetConcurrency: 1, concurrency: 1 })
  async auditDaily(payload: { day?: string }): Promise<void> {
    await this.audit.auditDay(payload.day);
  }
}
