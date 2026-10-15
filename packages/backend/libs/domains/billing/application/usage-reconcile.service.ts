import { Inject, Injectable, Logger } from '@nestjs/common';
import { usageLedgerDriftGauge } from '../domain/metrics';
import {
  SETTLEMENT_REPOSITORY,
  USAGE_STORE,
  type SettlementRepository,
  type UsageStorePort,
} from '../domain/ports';
import { overageAmount } from '../domain/usage-overage';
import type { SettlementRow } from '../domain/usage-types';

const PAGE = 500;

export interface ReconcileResult {
  examined: number;
  /** Rows that break an invariant: counted, logged, never corrected. */
  drift: number;
}

/**
 * The daily check of the settlement ledger (S18 FR-031). Two invariants of every open row: the settled amount is the
 * price of the settled quantity under the row's own snapshot, and the settled quantity does not exceed the exact
 * total of its period. It reports (gauge and an error log naming subscription, period and metric, no amounts) and
 * never writes: money is corrected by a person. Running it twice gives the same answer.
 */
@Injectable()
export class UsageReconcileService {
  private readonly logger = new Logger(UsageReconcileService.name);

  constructor(
    @Inject(SETTLEMENT_REPOSITORY)
    private readonly ledger: SettlementRepository,
    @Inject(USAGE_STORE) private readonly store: UsageStorePort,
  ) {}

  async run(): Promise<ReconcileResult> {
    const result: ReconcileResult = { examined: 0, drift: 0 };
    const subjects = new Map<string, string | null>();
    let after: string | null = null;
    for (;;) {
      const page: SettlementRow[] = await this.ledger.scanOpen(after, PAGE);
      if (page.length === 0) break;
      for (const [subjectId, rows] of await this.bySubject(page, subjects)) {
        const totals = await this.store.totals(
          subjectId,
          rows.map((row) => ({
            metric: row.metric,
            from: row.periodStart,
            to: row.periodEnd,
          })),
        );
        rows.forEach((row, i) => {
          result.examined++;
          if (!this.consistent(row, totals[i])) {
            result.drift++;
            this.logger.error(
              `usage ledger drift: subscription ${row.subscriptionId} period ${row.periodStart.toISOString()} metric ${row.metric}`,
            );
          }
        });
      }
      after = page[page.length - 1].id;
    }
    usageLedgerDriftGauge.set(result.drift);
    return result;
  }

  private consistent(row: SettlementRow, total: number): boolean {
    return (
      row.settledAmountMinor ===
        overageAmount(
          row.settledQuantity,
          row.includedQuantity,
          row.overagePer1000Minor,
        ) && row.settledQuantity <= total
    );
  }

  /** The page's rows grouped by the subject their subscription belongs to (usage is keyed by subject). */
  private async bySubject(
    page: SettlementRow[],
    known: Map<string, string | null>,
  ): Promise<Map<string, SettlementRow[]>> {
    const grouped = new Map<string, SettlementRow[]>();
    for (const row of page) {
      if (!known.has(row.subscriptionId))
        known.set(
          row.subscriptionId,
          await this.ledger.subjectOf(row.subscriptionId),
        );
      const subjectId = known.get(row.subscriptionId);
      if (!subjectId) continue;
      grouped.set(subjectId, [...(grouped.get(subjectId) ?? []), row]);
    }
    return grouped;
  }
}
