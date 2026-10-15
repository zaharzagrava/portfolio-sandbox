import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { monthToDate } from '../domain/period';
import type {
  ShopAggregate,
  SnapshotRepository,
  SnapshotRow,
} from '../domain/ports';
import { ReplicaReads } from './replica-reads';

interface Row {
  shopId: string;
  gross: string;
  commission: string;
  net: string;
  lines: number;
  payoutsPaidMinor: string;
  adjGrossMinor: string;
  adjCommissionMinor: string;
  adjLineCount: number;
  adjPayoutsMinor: string;
  knowledgeCutoff: Date;
  runId: string | null;
}

export const SNAPSHOT_COLUMNS = `s."shopId", s."gross"::text AS gross, s."commission"::text AS commission, s."net"::text AS net,
  s."lines" AS lines, s."payoutsPaidMinor"::text AS "payoutsPaidMinor", s."adjGrossMinor"::text AS "adjGrossMinor",
  s."adjCommissionMinor"::text AS "adjCommissionMinor", s."adjLineCount" AS "adjLineCount",
  s."adjPayoutsMinor"::text AS "adjPayoutsMinor", s."knowledgeCutoff" AS "knowledgeCutoff", s."runId" AS "runId"`;

export const toSnapshot = (month: string, row: Row): SnapshotRow => ({
  shopId: row.shopId,
  month,
  grossMinor: Number(row.gross),
  commissionMinor: Number(row.commission),
  netMinor: Number(row.net),
  lineCount: row.lines,
  payoutsPaidMinor: Number(row.payoutsPaidMinor),
  adjGrossMinor: Number(row.adjGrossMinor),
  adjCommissionMinor: Number(row.adjCommissionMinor),
  adjLineCount: row.adjLineCount,
  adjPayoutsMinor: Number(row.adjPayoutsMinor),
  knowledgeCutoff: new Date(row.knowledgeCutoff),
  runId: row.runId,
});

/**
 * Frozen month figures of closed periods (S16 FR-022). A closed month is read from here and from nowhere else
 * (FR-015); the close writes batches of at most `STATEMENTS_SNAPSHOT_BATCH` rows, invisible until the period is
 * `CLOSED`. Reads go to the reporting replica (once on the primary when it is unreachable); writes join the
 * caller's transaction.
 */
@Injectable()
export class SequelizeSnapshotRepository implements SnapshotRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly replica: ReplicaReads,
  ) {}

  async find(
    shopId: string,
    month: string,
    options: { primary?: boolean } = {},
  ): Promise<SnapshotRow | null> {
    const [row] = await this.replica.run(
      (db) =>
        db.query<Row>(
          `SELECT ${SNAPSHOT_COLUMNS} FROM "StatementSnapshot" s
          WHERE s."shopId" = CAST(:shopId AS uuid) AND s."month" = CAST(:month AS date)`,
          {
            type: QueryTypes.SELECT,
            replacements: { shopId, month: monthToDate(month) },
          },
        ),
      options,
    );
    return row ? toSnapshot(month, row) : null;
  }

  async writeBatch(
    month: string,
    rows: ShopAggregate[],
    cutoff: Date,
    runId: string,
    computedAt: Date,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const inserted = await this.sequelize.query<{ one: number }>(
      `INSERT INTO "StatementSnapshot"
         ("shopId", "month", "gross", "commission", "net", "lines", "computedAt", "knowledgeCutoff", "payoutsPaidMinor",
          "adjGrossMinor", "adjCommissionMinor", "adjLineCount", "adjPayoutsMinor", "runId")
       SELECT r."shopId"::uuid, CAST(:month AS date), r."gross", r."commission", r."gross" - r."commission", r."lines",
              CAST(:computedAt AS timestamptz), CAST(:cutoff AS timestamptz), r."paid",
              (SELECT coalesce(sum(a."grossDeltaMinor"), 0) FROM "StatementAdjustment" a
                WHERE a."shopId" = r."shopId"::uuid AND a."bookedMonth" = CAST(:month AS date) AND a."createdAt" <= CAST(:cutoff AS timestamptz)),
              (SELECT coalesce(sum(a."commissionDeltaMinor"), 0) FROM "StatementAdjustment" a
                WHERE a."shopId" = r."shopId"::uuid AND a."bookedMonth" = CAST(:month AS date) AND a."createdAt" <= CAST(:cutoff AS timestamptz)),
              (SELECT coalesce(sum(a."lineCountDelta"), 0) FROM "StatementAdjustment" a
                WHERE a."shopId" = r."shopId"::uuid AND a."bookedMonth" = CAST(:month AS date) AND a."createdAt" <= CAST(:cutoff AS timestamptz)),
              (SELECT coalesce(sum(a."payoutsPaidDeltaMinor"), 0) FROM "StatementAdjustment" a
                WHERE a."shopId" = r."shopId"::uuid AND a."bookedMonth" = CAST(:month AS date) AND a."createdAt" <= CAST(:cutoff AS timestamptz)),
              CAST(:runId AS uuid)
         FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(
           "shopId" text, "gross" bigint, "commission" bigint, "lines" int, "paid" bigint)
       ON CONFLICT ("shopId", "month") DO NOTHING
       RETURNING 1 AS one`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          month: monthToDate(month),
          cutoff: cutoff.toISOString(),
          computedAt: computedAt.toISOString(),
          runId,
          rows: JSON.stringify(
            rows.map((row) => ({
              shopId: row.shopId,
              gross: row.grossMinor,
              commission: row.commissionMinor,
              lines: row.lineCount,
              paid: row.payoutsPaidMinor,
            })),
          ),
        },
      },
    );
    return inserted.length;
  }

  async countForMonth(month: string): Promise<number> {
    const [row] = await this.sequelize.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "StatementSnapshot" WHERE "month" = CAST(:month AS date)`,
      { type: QueryTypes.SELECT, replacements: { month: monthToDate(month) } },
    );
    return row.n;
  }

  async deleteForMonth(month: string): Promise<void> {
    await this.sequelize.query(
      `DELETE FROM "StatementSnapshot" WHERE "month" = CAST(:month AS date)`,
      { replacements: { month: monthToDate(month) } },
    );
  }

  async page(
    month: string,
    afterShopId: string | null,
    limit: number,
  ): Promise<SnapshotRow[]> {
    const rows = await this.sequelize.query<Row>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM "StatementSnapshot" s
        WHERE s."month" = CAST(:month AS date) AND (CAST(:after AS uuid) IS NULL OR s."shopId" > CAST(:after AS uuid))
        ORDER BY s."shopId" LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: { month: monthToDate(month), after: afterShopId, limit },
      },
    );
    return rows.map((row) => toSnapshot(month, row));
  }
}
