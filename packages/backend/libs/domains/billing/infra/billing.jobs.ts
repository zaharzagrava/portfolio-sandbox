import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import type { JobContext } from '@app/infrastructure/jobs/job-types';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { AttemptResolutionService } from '../application/attempt-resolution.service';
import { ChargeService } from '../application/charge.service';
import { RenewalService } from '../application/renewal.service';
import '../application/billing.job-types';
import { STOP_SIGNAL, type StopSignal } from '../domain/ports';

/** The renewal run: every ten minutes, UTC, one run per slot across replicas (S49 claiming), lease 600 s. */
export const BILLING_RUN_SCHEDULE = {
  name: 'billing.run',
  cron: '*/10 * * * *',
  timezone: 'UTC',
} as const;

/**
 * Thin job handlers (S17 contracts/jobs.md, I.2): parse is done by the job registry from the declared contract, then
 * one call to a use case. A provider outcome is never a job error; only infrastructure failures throw and retry.
 * The schedule is registered once at boot (idempotent upsert, safe from every replica).
 */
@Injectable()
export class BillingJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly renewals: RenewalService,
    private readonly charges: ChargeService,
    private readonly resolution: AttemptResolutionService,
    @Inject(STOP_SIGNAL) private readonly stop: StopSignal,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.jobs.upsertSchedule({
      ...BILLING_RUN_SCHEDULE,
      jobType: 'billing.run',
      payload: {},
      overlap: 'skip',
      maxAttempts: 1,
    });
  }

  @JobHandler('billing.run', { concurrency: 1, leaseMs: 600_000 })
  async run(_payload: Record<string, never>, ctx: Pick<JobContext, 'signal'>) {
    const summary = await this.renewals.run(
      () => this.stop.isStopping() || ctx.signal.aborted,
    );
    this.logger.log(
      `billing run: ${summary.examined} examined, ${summary.invoiced} invoiced, ${summary.canceled + summary.expired} ended, ` +
        `${summary.deferred} deferred, ${summary.skipped} skipped, ${summary.failed} failed`,
    );
  }

  @JobHandler('billing.charge-invoice', { concurrency: 8 })
  async charge({ invoiceId }: { invoiceId: string }): Promise<void> {
    await this.charges.chargeInvoice(invoiceId);
  }

  @JobHandler('billing.resolve-attempt', { concurrency: 4 })
  async resolve(payload: {
    invoiceId: string;
    attempt: string;
    round?: number;
  }): Promise<void> {
    await this.resolution.resolve(
      payload.invoiceId,
      payload.attempt,
      payload.round ?? 0,
    );
  }

  @JobHandler('billing.manual-attempt', { concurrency: 4 })
  async manual(payload: { invoiceId: string; k: number }): Promise<void> {
    await this.charges.manualAttempt(payload.invoiceId, payload.k);
  }
}
