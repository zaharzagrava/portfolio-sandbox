import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  invariantViolationsCounter,
  projectionLagGauge,
} from '../domain/ledger-metrics';
import {
  BALANCE_DURABLE_STORE,
  BALANCE_HOT_STORE,
  LEDGER_MAINTENANCE_STORE,
  PROJECTION_PROGRESS,
  type BalanceReadModelStore,
  type CheckedBalanceRow,
  type LedgerMaintenanceStore,
  type ProjectionProgress,
} from '../domain/ledger-ports';
import { PartitionMaintenanceService } from './partition-maintenance.service';

const DAY_MS = 86_400_000;
const REPORT_LIMIT = 100;
const PAGE = 500;

export interface InvariantResult {
  journal_balanced: number;
  balance_matches_entries: number;
  read_model_matches: number;
}

/**
 * The nightly proof that the books agree with themselves (S14 FR-043, research R-11), bounded by the last two closed
 * UTC days and the accounts touched in them: journals balance, running balances equal their checkpoint plus the entries
 * since, and the read model equals the running balances. Each violation is counted under its check and logged by id
 * only. It never edits the ledger; the one thing it repairs is a corrupted read-model value (rewritten from the
 * running balance). It also refreshes the projection lag and catch-all partition gauges, so they keep moving when the
 * projector or the partition job is stopped.
 */
@Injectable()
export class InvariantCheckService {
  private readonly logger = new Logger(InvariantCheckService.name);

  constructor(
    @Inject(LEDGER_MAINTENANCE_STORE)
    private readonly store: LedgerMaintenanceStore,
    @Inject(BALANCE_HOT_STORE) private readonly hot: BalanceReadModelStore,
    @Inject(BALANCE_DURABLE_STORE)
    private readonly durable: BalanceReadModelStore,
    @Inject(PROJECTION_PROGRESS) private readonly progress: ProjectionProgress,
    private readonly partitions: PartitionMaintenanceService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(): Promise<InvariantResult> {
    const now = this.clock.now();
    const to = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
    const from = new Date(to.getTime() - 2 * DAY_MS);
    const result: InvariantResult = {
      journal_balanced: 0,
      balance_matches_entries: 0,
      read_model_matches: 0,
    };
    const bad = new Set<string>();

    for (const journal of await this.store.unbalancedJournals(
      from,
      to,
      REPORT_LIMIT,
    )) {
      result.journal_balanced++;
      invariantViolationsCounter.add(1, { check: 'journal_balanced' });
      this.logger.error(
        `LEDGER INVARIANT VIOLATED journal_balanced: journal ${journal.journalId} sums to ${journal.sum}`,
      );
    }

    for (const drift of await this.store.balanceDrift(from, to, REPORT_LIMIT)) {
      result.balance_matches_entries++;
      bad.add(`${drift.accountId}|${drift.shard}|${drift.currency}`);
      invariantViolationsCounter.add(1, { check: 'balance_matches_entries' });
      this.logger.error(
        `LEDGER INVARIANT VIOLATED balance_matches_entries: account ${drift.accountId} shard ${drift.shard} has ${drift.actual}, entries say ${drift.expected}`,
      );
    }

    let after: { accountId: string; shard: number; currency: string } | null =
      null;
    for (;;) {
      const rows: CheckedBalanceRow[] = await this.store.touchedBalances(
        from,
        to,
        after,
        PAGE,
      );
      if (rows.length === 0) break;
      for (const row of rows)
        result.read_model_matches += await this.checkReadModel(row, now);
      after = rows[rows.length - 1];
      if (rows.length < PAGE) break;
    }

    await this.store.advanceCheckpoints(from, to, [...bad]);

    await this.partitions.refreshDefaultGauge();
    await this.refreshLag(now);
    return result;
  }

  /** Compares one running balance with both read-model copies and rewrites a corrupted one; returns the violations. */
  private async checkReadModel(
    row: CheckedBalanceRow,
    now: Date,
  ): Promise<number> {
    let violations = 0;
    const line = { ...row, projectedAt: now };
    for (const [name, store] of [
      ['durable', this.durable],
      ['hot', this.hot],
    ] as const) {
      const stored = (await store.get(row.accountId)).find(
        (l) => l.shard === row.shard && l.currency === row.currency,
      );
      // A missing or older line is projection lag, not corruption: the gauge says so. The same version with another value is corruption.
      if (
        stored &&
        stored.version === row.version &&
        stored.balanceMinor !== row.balanceMinor
      ) {
        violations++;
        invariantViolationsCounter.add(1, { check: 'read_model_matches' });
        this.logger.error(
          `LEDGER INVARIANT VIOLATED read_model_matches: ${name} copy of account ${row.accountId} shard ${row.shard} shows ${stored.balanceMinor}, running balance is ${row.balanceMinor}`,
        );
        await store.overwrite(line);
      }
    }
    return violations;
  }

  /** Seconds the oldest journal the projector has not applied has been waiting; 0 when it is up to date. */
  private async refreshLag(now: Date): Promise<void> {
    const last =
      (await this.progress.last()) ?? new Date(now.getTime() - 2 * DAY_MS);
    const oldest = await this.store.oldestPostedAfter(last);
    projectionLagGauge.set(
      oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0,
    );
  }
}
