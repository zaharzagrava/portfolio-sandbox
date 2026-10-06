import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { metrics } from '@opentelemetry/api';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'ledger.ensure-partitions': { monthsAhead?: number };
    'ledger.verify-invariants': Record<string, never>;
  }
}

@Injectable()
export class LedgerMaintenanceJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(LedgerMaintenanceJobs.name);
  private readonly violations = metrics.getMeter('ledger').createCounter('ledger_invariant_violations_total');

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({ name: 'ledger.ensure-partitions', cron: '0 3 1 * *', jobType: 'ledger.ensure-partitions', payload: {} });
    await this.jobs.upsertSchedule({ name: 'ledger.verify-invariants', cron: '15 2 * * *', jobType: 'ledger.verify-invariants', payload: {} });
  }

  /** Monthly partitions created months ahead - inserts never fall into the default partition. */
  @JobHandler('ledger.ensure-partitions', { concurrency: 1 })
  async ensurePartitions({ monthsAhead = 3 }: { monthsAhead?: number }) {
    await this.sequelize.query(`SELECT ledger_ensure_partitions(now()::date, :months)`, { replacements: { months: monthsAhead + 1 } });
  }

  /**
   * Belt and braces on top of the commit-time trigger: the whole book sums to
   * zero, and no journal from the last 2 days is unbalanced (e.g. rows inserted
   * by a manual script with the trigger disabled). Violations page someone (O-01).
   */
  @JobHandler('ledger.verify-invariants', { concurrency: 1, leaseMs: 300_000 })
  async verify() {
    const [{ total }] = await this.sequelize.query<{ total: string }>(`SELECT coalesce(sum(amount), 0)::text AS total FROM "LedgerEntry"`, {
      type: QueryTypes.SELECT,
    });
    const unbalanced = await this.sequelize.query<{ journalId: string; sum: string }>(
      `SELECT "journalId", sum(amount)::text AS sum FROM "LedgerEntry"
       WHERE "createdAt" >= now() - interval '2 days' GROUP BY "journalId" HAVING sum(amount) <> 0 LIMIT 100`,
      { type: QueryTypes.SELECT },
    );
    if (total !== '0' || unbalanced.length) {
      this.violations.add(1 + unbalanced.length);
      this.logger.error(`LEDGER INVARIANT VIOLATED: book total ${total}, unbalanced journals: ${unbalanced.map((u) => u.journalId).join(', ')}`);
    }
  }
}
