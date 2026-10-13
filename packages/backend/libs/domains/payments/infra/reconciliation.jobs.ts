import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import {
  NonRetryableJobError,
  type JobContext,
} from '@app/infrastructure/jobs/job-types';
import {
  RECONCILIATION_PROVIDER,
  ReconciliationRunService,
  type RunOutcome,
} from '../application/reconciliation-run.service';
import {
  RECONCILIATION_STORE,
  type ReconciliationStore,
} from '../domain/ledger-ports';
import {
  RECONCILIATION_MAX_ATTEMPTS,
  catchUpDays,
  validateDay,
} from '../domain/reconciliation-window';
import { upsertLedgerSchedule } from './schedule-bootstrap';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'payments.reconcile-daily': { day?: string };
  }
}

declareJobType({
  name: 'payments.reconcile-daily',
  contract: z.object({ day: z.string().optional() }),
  maxAttempts: RECONCILIATION_MAX_ATTEMPTS,
});

const DAY_MS = 86_400_000;

/**
 * The daily reconciliation job (S14 FR-032…FR-034): with a `day` it reconciles exactly that closed UTC day; without
 * one it runs yesterday and catches up the days of the last week without a `COMPLETED` run, oldest first. The clock
 * is injected. A provider failure fails the run and the job (the job layer retries, at most three attempts).
 */
@Injectable()
export class ReconciliationJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationJobs.name);

  constructor(
    private readonly runs: ReconciliationRunService,
    @Inject(RECONCILIATION_STORE) private readonly store: ReconciliationStore,
    private readonly jobs: JobsService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await upsertLedgerSchedule(this.jobs, this.logger, {
      name: 'payments.reconcile-daily',
      cron: '30 2 * * *',
      jobType: 'payments.reconcile-daily',
      payload: {},
    });
  }

  @JobHandler('payments.reconcile-daily', { concurrency: 1, leaseMs: 600_000 })
  async reconcile(
    payload: { day?: string },
    ctx?: Pick<JobContext, 'heartbeat' | 'signal'>,
  ): Promise<RunOutcome[]> {
    const now = this.clock.now();
    let days: string[];
    if (payload.day !== undefined) {
      const checked = validateDay(payload.day, now);
      if (!checked.ok) throw new NonRetryableJobError(checked.code);
      days = [checked.day];
    } else {
      const span = this.config.get('reconciliation_catchup_days');
      const today = new Date(now.getTime());
      today.setUTCHours(0, 0, 0, 0);
      const from = new Date(today.getTime() - span * DAY_MS)
        .toISOString()
        .slice(0, 10);
      const done = new Set(
        await this.store.completedDays(
          RECONCILIATION_PROVIDER,
          from,
          today.toISOString().slice(0, 10),
        ),
      );
      days = catchUpDays(now, done, span);
    }

    const outcomes: RunOutcome[] = [];
    for (const day of days) {
      const outcome = await this.runs.runDay(day, {
        heartbeat: ctx?.heartbeat,
        signal: ctx?.signal,
      });
      outcomes.push(outcome);
      this.logger.log(`reconciliation ${day}: ${outcome.outcome}`);
      if (outcome.outcome === 'interrupted') break;
    }
    return outcomes;
  }
}
