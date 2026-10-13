import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import { orderEventSchemas } from '@marketplace-sandbox/contracts';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import type { JobContext } from '@app/infrastructure/jobs/job-types';
import { BalanceBackfillService } from '../application/balance-backfill.service';
import { HotAccountSweepService } from '../application/hot-account-sweep.service';
import { InvariantCheckService } from '../application/invariant-check.service';
import { PartitionMaintenanceService } from '../application/partition-maintenance.service';
import {
  SettlementService,
  type OrderPaidPayload,
} from '../application/settlement.service';
import {
  consumerDeadLetteredCounter,
  settlementDeadLetteredCounter,
} from '../domain/ledger-metrics';
import { JOB_LOCK, type JobLock } from '../domain/ledger-ports';
import { SETTLEMENT_ATTEMPTS } from '../domain/settlement-retry';
import {
  LEDGER_JOB_ATTEMPTS,
  upsertLedgerSchedule,
} from './schedule-bootstrap';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'ledger.settle-order': { paid: OrderPaidPayload; attempt: number };
    'ledger.sweep-hot-accounts': { window?: string };
    'ledger.ensure-partitions': { monthsAhead?: number };
    'ledger.verify-invariants': Record<string, never>;
    'ledger.backfill-balances': { batch?: number };
  }
}

declareJobType({
  name: 'ledger.settle-order',
  contract: z.object({
    paid: orderEventSchemas['order.paid'],
    attempt: z.number().int().min(2).max(SETTLEMENT_ATTEMPTS),
  }),
  // The handler enqueues its own next step on the schedule (30 s … 210 s); the job layer never retries it.
  maxAttempts: 1,
});

declareJobType({
  name: 'ledger.sweep-hot-accounts',
  contract: z.object({ window: z.string().datetime().optional() }).strict(),
  maxAttempts: LEDGER_JOB_ATTEMPTS,
});

declareJobType({
  name: 'ledger.ensure-partitions',
  contract: z
    .object({ monthsAhead: z.number().int().min(1).max(12).optional() })
    .strict(),
  maxAttempts: LEDGER_JOB_ATTEMPTS,
});

declareJobType({
  name: 'ledger.verify-invariants',
  contract: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: LEDGER_JOB_ATTEMPTS,
});

declareJobType({
  name: 'ledger.backfill-balances',
  contract: z
    .object({ batch: z.number().int().min(1).max(5_000).optional() })
    .strict(),
  maxAttempts: LEDGER_JOB_ATTEMPTS,
});

export type JobRun = 'ran' | 'already_running';

const LOCK_TTL_MS = 600_000;

/** Job handlers of the ledger (S14 contracts/events.md "Jobs"). Each runs once at a time; running twice equals once. */
@Injectable()
export class LedgerJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(LedgerJobs.name);

  constructor(
    private readonly settlement: SettlementService,
    private readonly sweep: HotAccountSweepService,
    private readonly partitions: PartitionMaintenanceService,
    private readonly invariants: InvariantCheckService,
    private readonly backfill: BalanceBackfillService,
    private readonly jobs: JobsService,
    @Inject(JOB_LOCK) private readonly lock: JobLock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const schedule of [
      {
        name: 'ledger.sweep-hot-accounts',
        cron: '5 * * * *',
        jobType: 'ledger.sweep-hot-accounts' as const,
      },
      {
        name: 'ledger.ensure-partitions',
        cron: '0 3 * * 1',
        jobType: 'ledger.ensure-partitions' as const,
      },
      {
        name: 'ledger.verify-invariants',
        cron: '15 2 * * *',
        jobType: 'ledger.verify-invariants' as const,
      },
    ])
      await upsertLedgerSchedule(this.jobs, this.logger, {
        ...schedule,
        payload: {},
      });
  }

  /** Hourly: consolidates the shards of the three hot accounts into shard 0 (FR-019). */
  @JobHandler('ledger.sweep-hot-accounts', { concurrency: 1, leaseMs: 300_000 })
  sweepHotAccounts(payload: { window?: string }): Promise<JobRun> {
    return this.once('ledger.sweep-hot-accounts', async () => {
      const swept = await this.sweep.sweepAll(payload.window);
      this.logger.log(
        `sweep: ${swept.filter((s) => s.created).length} journals, ${swept.reduce((n, s) => n + s.shards, 0)} shards moved`,
      );
    });
  }

  /** Weekly: the current month and the next three exist; the catch-all partition is emptied (FR-042). */
  @JobHandler('ledger.ensure-partitions', { concurrency: 1, leaseMs: 300_000 })
  ensurePartitions(payload: { monthsAhead?: number }): Promise<JobRun> {
    return this.once('ledger.ensure-partitions', () =>
      this.partitions.ensure(payload),
    );
  }

  /** Nightly: journals balance, running balances equal their entries, the read model equals the balances (FR-043). */
  @JobHandler('ledger.verify-invariants', { concurrency: 1, leaseMs: 600_000 })
  verifyInvariants(_payload: Record<string, never>): Promise<JobRun> {
    return this.once(
      'ledger.verify-invariants',
      async () => void (await this.invariants.run()),
    );
  }

  /** One-off, resumable: headers and running balances for the entries that predate them (FR-045). */
  @JobHandler('ledger.backfill-balances', { concurrency: 1, leaseMs: 600_000 })
  backfillBalances(
    payload: { batch?: number },
    ctx?: Pick<JobContext, 'heartbeat' | 'signal'>,
  ): Promise<JobRun> {
    return this.once('ledger.backfill-balances', async () => {
      await this.backfill.run({
        batch: payload.batch,
        signal: ctx?.signal,
        heartbeat: ctx?.heartbeat,
      });
    });
  }

  /**
   * One deferred attempt of a settlement whose sale was not recorded yet (research R-6). It settles, or enqueues the
   * next step of the schedule, or after the 6th attempt ends as a dead job with `ledger_settlement_dead_lettered`.
   */
  @JobHandler('ledger.settle-order', { concurrency: 8 })
  async settleOrder(payload: {
    paid: OrderPaidPayload;
    attempt: number;
  }): Promise<void> {
    const outcome = await this.settlement.settle(payload.paid);
    if (outcome === 'currency_mismatch' || outcome === 'invalid_payload') {
      consumerDeadLetteredCounter.add(1, { reason: outcome });
      throw new Error(`${outcome}: order ${payload.paid.orderId}`);
    }
    if (outcome !== 'sale_missing') return;
    if (await this.settlement.defer(payload.paid, payload.attempt)) return;
    settlementDeadLetteredCounter.add(1, { reason: 'sale_not_found' });
    this.logger.error(
      `settlement of order ${payload.paid.orderId} gave up after ${payload.attempt} attempts: sale_not_found`,
    );
    throw new Error(`sale_not_found: order ${payload.paid.orderId}`);
  }

  private async once(name: string, work: () => Promise<void>): Promise<JobRun> {
    const token = await this.lock.acquire(name, LOCK_TTL_MS);
    if (!token) return 'already_running';
    try {
      await work();
      return 'ran';
    } finally {
      await this.lock.release(name, token);
    }
  }
}
