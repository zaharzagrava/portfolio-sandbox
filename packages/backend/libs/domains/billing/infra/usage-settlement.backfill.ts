import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import {
  SETTLEMENT_REPOSITORY,
  USAGE_STORE,
  type SettlementRepository,
  type UsageStorePort,
} from '../domain/ports';
import { overageAmount } from '../domain/usage-overage';
import { isPeriodFinal } from '../domain/usage-period';
import { minor, select } from './sql';

const PAGE = 200;
const WINDOW_MS = 90 * 86_400_000;

interface Candidate {
  invoiceId: string;
  subscriptionId: string;
  subjectId: string;
  /** The period whose usage the invoice billed: `[previous renewal's periodStart, this invoice's periodStart)`. */
  usageStart: Date;
  usageEnd: Date;
  measuredAt: Date;
  nextInvoiceId: string | null;
  nextMeasuredAt: Date | null;
  includedUsage: Record<string, number>;
  overagePer1000: Record<string, number>;
}

/**
 * Ledger rows for the renewal invoices of the last 90 days that the previous implementation issued (S18 FR-032,
 * data-model.md, section on the migration). Repeatable: `INSERT … ON CONFLICT DO NOTHING`, so a second run changes nothing, and
 * re-runnable when the usage store was unreachable (the failure is raised, nothing partial is hidden).
 *
 * The old code billed the events of a period that arrived after the invoice measured it as an adjustment on the
 * NEXT invoice. So the quantity already billed for a period is the usage that existed when the next measuring
 * invoice ran, when there is one, otherwise at the measurement of the invoice that billed the period. Taking only the
 * first measurement would bill those late units a second time.
 */
@Injectable()
export class UsageSettlementBackfill {
  private readonly logger = new Logger(UsageSettlementBackfill.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @Inject(USAGE_STORE) private readonly store: UsageStorePort,
    @Inject(SETTLEMENT_REPOSITORY)
    private readonly ledger: SettlementRepository,
  ) {}

  async run(
    now: Date,
  ): Promise<{ examined: number; inserted: number; mismatches: number }> {
    const since = new Date(now.getTime() - WINDOW_MS);
    const result = { examined: 0, inserted: 0, mismatches: 0 };
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const page = await this.page(since, after);
      if (page.length === 0) return result;
      for (const candidate of page) {
        result.examined++;
        const done = await this.migrate(candidate, now);
        result.inserted += done.inserted;
        result.mismatches += done.mismatches;
      }
      after = page[page.length - 1].invoiceId;
    }
  }

  private async page(since: Date, after: string): Promise<Candidate[]> {
    const rows = await select<{
      invoiceId: string;
      subscriptionId: string;
      subjectId: string;
      usageStart: Date;
      usageEnd: Date;
      measuredAt: Date;
      nextInvoiceId: string | null;
      nextMeasuredAt: Date | null;
      includedUsage: Record<string, number>;
      overagePer1000: Record<string, number>;
    }>(
      this.sequelize,
      `SELECT i."id" AS "invoiceId", i."subscriptionId", s."subjectId",
              prev."periodStart" AS "usageStart", i."periodStart" AS "usageEnd", i."usageMeasuredAt" AS "measuredAt",
              nxt."id" AS "nextInvoiceId", nxt."usageMeasuredAt" AS "nextMeasuredAt",
              pr."includedUsage", pr."overagePer1000"
         FROM "Invoice" i
         JOIN "Subscription" s ON s."id" = i."subscriptionId"
         JOIN "Price" pr ON pr."id" = s."priceId"
         JOIN LATERAL (SELECT p."periodStart" FROM "Invoice" p
                        WHERE p."subscriptionId" = i."subscriptionId" AND p."kind" = 'RENEWAL'
                          AND p."periodStart" < i."periodStart"
                        ORDER BY p."periodStart" DESC LIMIT 1) prev ON TRUE
         LEFT JOIN LATERAL (SELECT n."id", n."usageMeasuredAt" FROM "Invoice" n
                             WHERE n."subscriptionId" = i."subscriptionId" AND n."kind" = 'RENEWAL'
                               AND n."periodStart" > i."periodStart" AND n."usageMeasuredAt" IS NOT NULL
                             ORDER BY n."periodStart" ASC LIMIT 1) nxt ON TRUE
        WHERE i."kind" = 'RENEWAL' AND i."usageMeasuredAt" IS NOT NULL AND i."usageMeasuredAt" >= :since
          AND i."id" > CAST(:after AS uuid)
        ORDER BY i."id" LIMIT :limit`,
      { since, after, limit: PAGE },
    );
    return rows.map((r) => ({
      ...r,
      usageStart: new Date(r.usageStart),
      usageEnd: new Date(r.usageEnd),
      measuredAt: new Date(r.measuredAt),
      nextMeasuredAt: r.nextMeasuredAt ? new Date(r.nextMeasuredAt) : null,
    }));
  }

  private async migrate(
    c: Candidate,
    now: Date,
  ): Promise<{ inserted: number; mismatches: number }> {
    let inserted = 0;
    let mismatches = 0;
    for (const [metric, includedRaw] of Object.entries(c.includedUsage)) {
      const included = Number(includedRaw);
      const rate = Number(c.overagePer1000[metric] ?? 0);
      const window = { metric, from: c.usageStart, to: c.usageEnd };
      const effectiveAt = c.nextMeasuredAt ?? c.measuredAt;
      const total = await this.store.totalIngestedBy(
        c.subjectId,
        window,
        effectiveAt,
      );
      const amount = overageAmount(total, included, rate);

      // what the invoice itself billed for the metric must equal the price of the usage at its own measurement
      const ownTotal = c.nextMeasuredAt
        ? await this.store.totalIngestedBy(c.subjectId, window, c.measuredAt)
        : total;
      const billed = await this.billedUsage(c.invoiceId, metric);
      if (billed !== overageAmount(ownTotal, included, rate)) {
        mismatches++;
        this.logger.warn(
          `usage ledger backfill: invoice ${c.invoiceId} billed ${metric} differently from its usage at the measurement; the ledger row uses the recomputed value`,
        );
      }

      const created = await this.ledger.insertFirst(
        {
          subscriptionId: c.subscriptionId,
          periodStart: c.usageStart,
          periodEnd: c.usageEnd,
          metric,
          settledQuantity: total,
          settledAmountMinor: amount,
          includedQuantity: included,
          overagePer1000Minor: rate,
          lastInvoiceId: c.nextInvoiceId ?? c.invoiceId,
          closed: isPeriodFinal(c.usageEnd, effectiveAt),
        },
        now,
      );
      if (created) inserted++;
    }
    return { inserted, mismatches };
  }

  /** The amount of the invoice's `USAGE` lines of a metric (0 when it has none). */
  private async billedUsage(
    invoiceId: string,
    metric: string,
  ): Promise<number> {
    const [row] = await select<{ amount: string | null }>(
      this.sequelize,
      `SELECT sum("amount") AS "amount" FROM "InvoiceLine"
        WHERE "invoiceId" = :invoiceId AND "kind" = 'USAGE'
          AND ("description" LIKE :prefix OR "description" LIKE :newPrefix)`,
      {
        invoiceId,
        prefix: `${metric} over %`,
        newPrefix: `${metric}: %`,
      },
    );
    return row?.amount ? minor(row.amount) : 0;
  }
}
