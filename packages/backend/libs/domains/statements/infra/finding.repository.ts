import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type { FindingDraft, FindingKind } from '../domain/reconciliation';
import { monthBounds, monthToDate } from '../domain/period';
import type {
  FindingRepository,
  FindingRow,
  LedgerComparison,
} from '../domain/ports';
import { iso, monthText, trimMicros } from './sql';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

interface Row {
  id: string;
  month: string;
  kind: FindingKind;
  shopId: string | null;
  expected: string;
  actual: string;
  difference: string;
  status: 'OPEN' | 'CLEARED';
  openedAt: string;
  clearedAt: string | null;
}

/**
 * Reconciliation findings and the comparisons behind them (S16 research R-8), over the statements' own tables only:
 * facts, ledger copies, snapshots. One finding per (month, kind, shop); a later run that agrees clears it.
 */
@Injectable()
export class SequelizeFindingRepository implements FindingRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  async ledgerComparison(month: string): Promise<LedgerComparison> {
    const { start, end } = monthBounds(month);
    const params = {
      month: monthToDate(month),
      start: start.toISOString(),
      end: end.toISOString(),
    };
    const orders = `SELECT DISTINCT f."orderId" FROM "StatementSaleFact" f
                     WHERE f."paidAt" >= CAST(:start AS timestamptz) AND f."paidAt" < CAST(:end AS timestamptz)`;

    const net = await this.select<{ shopId: string; expected: string; actual: string }>(
      `WITH credited AS (
         SELECT substring(c."accountId" from 6) AS shop, sum(c."amountMinor") AS amount
           FROM "StatementLedgerCredit" c JOIN "StatementLedgerFact" j ON j."journalId" = c."journalId"
          WHERE j."orderId" IN (${orders}) AND c."accountId" LIKE 'SHOP\\_%'
          GROUP BY 1)
       SELECT cr.shop AS "shopId", coalesce(s."net", 0)::text AS expected, cr.amount::text AS actual
         FROM credited cr
         LEFT JOIN "StatementSnapshot" s ON s."shopId"::text = cr.shop AND s."month" = CAST(:month AS date)
        ORDER BY cr.shop`,
      params,
    );

    const [fees] = await this.select<{ linked: string; expected: string; actual: string }>(
      `SELECT (SELECT count(*) FROM "StatementLedgerFact" j WHERE j."orderId" IN (${orders}))::text AS linked,
              coalesce((SELECT sum(s."commission") FROM "StatementSnapshot" s WHERE s."month" = CAST(:month AS date)), 0)::text AS expected,
              coalesce((SELECT sum(c."amountMinor") FROM "StatementLedgerCredit" c
                          JOIN "StatementLedgerFact" j ON j."journalId" = c."journalId"
                         WHERE j."orderId" IN (${orders}) AND c."accountId" = 'PLATFORM_FEES'), 0)::text AS actual`,
      params,
    );

    const unjournalled = await this.select<{ shopId: string; gross: string }>(
      `SELECT f."shopId", sum(f."lineTotalMinor")::text AS gross
         FROM "StatementSaleFact" f
        WHERE f."paidAt" >= CAST(:start AS timestamptz) AND f."paidAt" < CAST(:end AS timestamptz)
          AND f."orderVersion" = (SELECT max(g."orderVersion") FROM "StatementSaleFact" g WHERE g."orderId" = f."orderId")
          AND NOT EXISTS (SELECT 1 FROM "StatementLedgerFact" j WHERE j."orderId" = f."orderId")
        GROUP BY f."shopId" ORDER BY f."shopId"`,
      params,
    );

    const [journals] = await this.select<{ without: string; unlinked: string }>(
      `SELECT (SELECT count(*) FROM "StatementLedgerFact" j
                WHERE j."orderId" IS NOT NULL AND j."postedAt" >= CAST(:start AS timestamptz) AND j."postedAt" < CAST(:end AS timestamptz)
                  AND NOT EXISTS (SELECT 1 FROM "StatementSaleFact" f WHERE f."orderId" = j."orderId"))::text AS without,
              (SELECT count(*) FROM "StatementLedgerFact" j
                WHERE j."orderId" IS NULL AND j."postedAt" >= CAST(:start AS timestamptz) AND j."postedAt" < CAST(:end AS timestamptz))::text AS unlinked`,
      params,
    );

    return {
      net: net.map((r) => ({
        shopId: r.shopId,
        expectedMinor: Number(r.expected),
        actualMinor: Number(r.actual),
      })),
      fees:
        Number(fees.linked) > 0
          ? { expectedMinor: Number(fees.expected), actualMinor: Number(fees.actual) }
          : null,
      unjournalled: unjournalled.map((r) => ({
        shopId: r.shopId,
        grossMinor: Number(r.gross),
      })),
      journalsWithoutSale: Number(journals.without),
      unlinkedJournals: Number(journals.unlinked),
    };
  }

  async sync(
    month: string,
    kinds: FindingKind[],
    drafts: FindingDraft[],
    now: Date,
  ): Promise<FindingDraft[]> {
    const date = monthToDate(month);
    const before = new Set(await this.openKeys(month, kinds));
    for (const d of drafts)
      await this.sequelize.query(
        `INSERT INTO "StatementFinding" ("month","kind","shopId","expectedMinor","actualMinor","differenceMinor","status","openedAt")
         VALUES (CAST(:month AS date), :kind, CAST(:shopId AS uuid), :expected, :actual, :difference, 'OPEN', CAST(:now AS timestamptz))
         ON CONFLICT ("month","kind",(coalesce("shopId", CAST('${ZERO_UUID}' AS uuid)))) DO UPDATE
           SET "expectedMinor" = EXCLUDED."expectedMinor", "actualMinor" = EXCLUDED."actualMinor",
               "differenceMinor" = EXCLUDED."differenceMinor", "status" = 'OPEN',
               "openedAt" = CASE WHEN "StatementFinding"."status" = 'OPEN' THEN "StatementFinding"."openedAt" ELSE EXCLUDED."openedAt" END,
               "clearedAt" = NULL`,
        {
          replacements: {
            month: date,
            kind: d.kind,
            shopId: d.shopId,
            expected: d.expectedMinor,
            actual: d.actualMinor,
            difference: d.differenceMinor,
            now: now.toISOString(),
          },
        },
      );

    const keep = drafts.map((d) => `${d.kind}:${d.shopId ?? '-'}`);
    await this.sequelize.query(
      `UPDATE "StatementFinding" SET "status" = 'CLEARED', "clearedAt" = CAST(:now AS timestamptz)
        WHERE "month" = CAST(:month AS date) AND "status" = 'OPEN' AND "kind" = ANY(CAST(:kinds AS text[]))
          AND ("kind" || ':' || coalesce("shopId"::text, '-')) <> ALL(CAST(:keep AS text[]))`,
      {
        replacements: {
          now: now.toISOString(),
          month: date,
          kinds: `{${kinds.join(',')}}`,
          keep: `{${keep.join(',')}}`,
        },
      },
    );
    // newly opened: not open before this run (a cleared finding that came back counts too)
    return drafts.filter((d) => !before.has(`${d.kind}:${d.shopId ?? '-'}`));
  }

  private async openKeys(month: string, kinds: FindingKind[]): Promise<string[]> {
    const rows = await this.select<{ key: string }>(
      `SELECT ("kind" || ':' || coalesce("shopId"::text, '-')) AS key FROM "StatementFinding"
        WHERE "month" = CAST(:month AS date) AND "status" = 'OPEN' AND "kind" = ANY(CAST(:kinds AS text[]))`,
      { month: monthToDate(month), kinds: `{${kinds.join(',')}}` },
    );
    return rows.map((r) => r.key);
  }

  async markVerified(month: string, now: Date): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "StatementVerification" ("month","verifiedAt","findingsOpen")
       VALUES (CAST(:month AS date), CAST(:now AS timestamptz),
               (SELECT count(*) FROM "StatementFinding" WHERE "month" = CAST(:month AS date) AND "status" = 'OPEN'))
       ON CONFLICT ("month") DO UPDATE SET "verifiedAt" = EXCLUDED."verifiedAt", "findingsOpen" = EXCLUDED."findingsOpen"`,
      { replacements: { month: monthToDate(month), now: now.toISOString() } },
    );
  }

  async page(
    month: string,
    before: { openedAt: string; id: string } | null,
    limit: number,
  ): Promise<FindingRow[]> {
    const rows = await this.select<Row>(
      `SELECT "id", ${monthText('"month"')} AS month, "kind", "shopId", "expectedMinor"::text AS expected,
              "actualMinor"::text AS actual, "differenceMinor"::text AS difference, "status",
              ${iso('"openedAt"')} AS "openedAt", ${iso('"clearedAt"')} AS "clearedAt"
         FROM "StatementFinding"
        WHERE "month" = CAST(:month AS date)
          AND (CAST(:beforeAt AS timestamptz) IS NULL OR ("openedAt", "id") < (CAST(:beforeAt AS timestamptz), CAST(:beforeId AS uuid)))
        ORDER BY "openedAt" DESC, "id" DESC LIMIT :limit`,
      {
        month: monthToDate(month),
        beforeAt: before?.openedAt ?? null,
        beforeId: before?.id ?? null,
        limit,
      },
    );
    return rows.map((r) => ({
      id: r.id,
      month: r.month,
      kind: r.kind,
      shopId: r.shopId,
      expectedMinor: Number(r.expected),
      actualMinor: Number(r.actual),
      differenceMinor: Number(r.difference),
      status: r.status,
      openedAt: trimMicros(r.openedAt)!,
      clearedAt: trimMicros(r.clearedAt),
    }));
  }
}
