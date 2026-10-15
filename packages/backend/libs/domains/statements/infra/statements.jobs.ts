import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { NonRetryableJobError } from '@app/infrastructure/jobs/job-types';
import type { JobContext } from '@app/infrastructure/jobs/job-types';
import { AdjustmentService } from '../application/adjustment.service';
import { PeriodCloseService } from '../application/period-close.service';
import { VerificationService } from '../application/verification.service';
import '../application/statements.job-types';
import '../application/commission-rate.job-types';
import { STATEMENTS_CONFIG, type StatementsConfig } from '../domain/config';
import { monthBounds } from '../domain/period';
import {
  DEFAULT_SHOP_KEY,
  PERIOD_REPOSITORY,
  type PeriodRepository,
} from '../domain/ports';

/** Longest one job attempt may run (`STATEMENTS_JOB_TIMEOUT_MS`, read when the handler is declared). */
const JOB_TIMEOUT_MS = Math.max(
  600_000,
  Number(process.env.STATEMENTS_JOB_TIMEOUT_MS) || 0,
);

const STOP_CODES = new Set(['period_not_ended', 'month_not_available']);

/**
 * Thin job handlers of the statements (S16 contracts/jobs.md): parse, call one use case, map the result. A job that
 * can never succeed (a month that has not ended) goes dead instead of retrying. The close schedule is registered at
 * boot in UTC (A23), idempotently.
 */
@Injectable()
export class StatementsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(StatementsJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly closing: PeriodCloseService,
    private readonly adjustments: AdjustmentService,
    private readonly verification: VerificationService,
    @Inject(PERIOD_REPOSITORY) private readonly periods: PeriodRepository,
    @Inject(STATEMENTS_CONFIG) private readonly config: StatementsConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.schedule({
      name: 'statements.close-month',
      cron: this.config.closeSchedule,
      timezone: this.config.closeScheduleTz,
      jobType: 'statements.close-month',
      payload: {},
    });
    await this.schedule({
      name: 'statements.verify-periods',
      cron: '0 4 * * *',
      timezone: 'UTC',
      jobType: 'statements.verify-periods',
      payload: {},
    });
  }

  private async schedule(
    schedule: Parameters<JobsService['upsertSchedule']>[0],
  ): Promise<void> {
    try {
      await this.jobs.upsertSchedule({ ...schedule, maxAttempts: 3 } as never);
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule ${schedule.name} refused: ${error.message}`);
    }
  }

  @JobHandler('statements.reconcile-month', {
    concurrency: 4,
    leaseMs: JOB_TIMEOUT_MS,
    maxRuntimeMs: JOB_TIMEOUT_MS,
  })
  async reconcileMonth(
    payload: { month: string; cause: string; shopId?: string },
    ctx: Pick<JobContext, 'signal'>,
  ): Promise<void> {
    await this.adjustments.reconcileMonth(
      payload.month,
      payload.cause,
      payload.shopId,
      () => ctx.signal.aborted,
    );
  }

  /** Rows queued by the old reader before this release: mapped onto the new work, then the type can be retired. */
  @JobHandler('statements.retro-adjust', { concurrency: 1, leaseMs: 600_000 })
  async retroAdjust(
    payload: {
      shopKey: string;
      category: string;
      from: string;
      to: string | null;
      reason: string;
    },
    ctx: Pick<JobContext, 'signal'>,
  ): Promise<void> {
    const from = Date.parse(payload.from);
    const to = payload.to ? Date.parse(payload.to) : Infinity;
    for (const month of await this.periods.closingOrClosedMonths()) {
      const { start, end } = monthBounds(month);
      if (end.getTime() <= from || start.getTime() >= to) continue;
      await this.adjustments.reconcileMonth(
        month,
        `rate_change:legacy:${payload.reason}`,
        payload.shopKey === DEFAULT_SHOP_KEY ? undefined : payload.shopKey,
        () => ctx.signal.aborted,
      );
    }
  }

  @JobHandler('statements.verify-period', {
    concurrency: 1,
    leaseMs: JOB_TIMEOUT_MS,
    maxRuntimeMs: JOB_TIMEOUT_MS,
  })
  async verifyPeriod(payload: { month: string }): Promise<void> {
    await this.verification.verifyPeriod(payload.month);
  }

  @JobHandler('statements.verify-periods', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: JOB_TIMEOUT_MS,
    maxRuntimeMs: JOB_TIMEOUT_MS,
  })
  async verifyPeriods(): Promise<void> {
    await this.verification.verifyRecent();
  }

  @JobHandler('statements.close-month', {
    fleetConcurrency: 1,
    concurrency: 1,
    leaseMs: JOB_TIMEOUT_MS,
    maxRuntimeMs: JOB_TIMEOUT_MS,
  })
  async closeMonth(
    payload: { month?: string; runId?: string },
    ctx: Pick<JobContext, 'signal'>,
  ): Promise<void> {
    const stop = () => ctx.signal.aborted;
    try {
      if (payload.month && payload.runId) {
        await this.closing.run(payload.month, payload.runId, stop);
        return;
      }
      await this.closing.closeDue(payload.month, stop);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code && STOP_CODES.has(code)) throw new NonRetryableJobError(code);
      throw error;
    }
  }
}
