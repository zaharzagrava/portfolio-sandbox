import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { monthToDate } from '../domain/period';
import type {
  AdjustmentFilter,
  AdjustmentRepository,
  NewAdjustment,
} from '../domain/ports';
import type { AdjustmentFigures } from '../domain/statement-view';
import { ReplicaReads } from './replica-reads';
import { iso, monthText, trimMicros } from './sql';

interface Row {
  id: string;
  shopId: string;
  refersToMonth: string;
  bookedMonth: string;
  causeKind: AdjustmentFigures['causeKind'];
  causeRef: string;
  gross: string;
  commission: string;
  lines: number;
  payouts: string;
  reason: string;
  createdAt: string;
}

export const ADJUSTMENT_COLUMNS = `a."id", a."shopId", ${monthText('a."refersToMonth"')} AS "refersToMonth",
  ${monthText('a."bookedMonth"')} AS "bookedMonth", a."causeKind" AS "causeKind", a."causeRef" AS "causeRef",
  a."grossDeltaMinor"::text AS gross, a."commissionDeltaMinor"::text AS commission, a."lineCountDelta" AS lines,
  a."payoutsPaidDeltaMinor"::text AS payouts, a."reason", ${iso('a."createdAt"')} AS "createdAt"`;

export const toAdjustment = (row: Row): AdjustmentFigures => ({
  id: row.id,
  shopId: row.shopId,
  refersToMonth: row.refersToMonth,
  bookedMonth: row.bookedMonth,
  causeKind: row.causeKind,
  causeRef: row.causeRef,
  grossDeltaMinor: Number(row.gross),
  commissionDeltaMinor: Number(row.commission),
  lineCountDelta: row.lines,
  payoutsPaidDeltaMinor: Number(row.payouts),
  reason: row.reason,
  createdAt: trimMicros(row.createdAt)!,
});

/** Booked adjustments of a shop; immutable once written (store trigger). Writes join the caller's transaction. */
@Injectable()
export class SequelizeAdjustmentRepository implements AdjustmentRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly replica: ReplicaReads,
  ) {}

  async forShop(
    shopId: string,
    filter: AdjustmentFilter,
  ): Promise<AdjustmentFigures[]> {
    const rows = await this.replica.run(
      (db) =>
        db.query<Row>(
          `SELECT ${ADJUSTMENT_COLUMNS} FROM "StatementAdjustment" a
          WHERE a."shopId" = CAST(:shopId AS uuid)
            AND (CAST(:booked AS date) IS NULL OR a."bookedMonth" = CAST(:booked AS date))
            AND (CAST(:refers AS date) IS NULL OR a."refersToMonth" = CAST(:refers AS date))
            AND (CAST(:before AS timestamptz) IS NULL OR a."createdAt" <= CAST(:before AS timestamptz))
          ORDER BY a."createdAt", a."id"`,
          {
            type: QueryTypes.SELECT,
            replacements: {
              shopId,
              booked: filter.bookedMonth
                ? monthToDate(filter.bookedMonth)
                : null,
              refers: filter.refersToMonth
                ? monthToDate(filter.refersToMonth)
                : null,
              before: filter.createdAtOrBefore?.toISOString() ?? null,
            },
          },
        ),
      { primary: filter.primary },
    );
    return rows.map(toAdjustment);
  }

  async lockShopMonth(shopId: string, month: string): Promise<void> {
    await this.sequelize.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))`,
      {
        type: QueryTypes.SELECT,
        replacements: { key: `statements:adjust:${shopId}:${month}` },
      },
    );
  }

  async insert(adjustment: NewAdjustment): Promise<string | null> {
    const rows = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "StatementAdjustment"
         ("shopId", "bookedMonth", "refersToMonth", "commissionDelta", "commissionDeltaMinor", "grossDeltaMinor",
          "lineCountDelta", "payoutsPaidDeltaMinor", "reason", "causeKind", "causeRef", "createdAt")
       VALUES (CAST(:shopId AS uuid), CAST(:booked AS date), CAST(:refers AS date), :commission, :commission, :gross,
               :lines, :payouts, :reason, :causeKind, :causeRef, CAST(:createdAt AS timestamptz))
       ON CONFLICT ("shopId", "refersToMonth", "causeKind", "causeRef") DO NOTHING
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          shopId: adjustment.shopId,
          booked: monthToDate(adjustment.bookedMonth),
          refers: monthToDate(adjustment.refersToMonth),
          commission: adjustment.commissionDeltaMinor,
          gross: adjustment.grossDeltaMinor,
          lines: adjustment.lineCountDelta,
          payouts: adjustment.payoutsPaidDeltaMinor,
          reason: adjustment.reason,
          causeKind: adjustment.causeKind,
          causeRef: adjustment.causeRef,
          createdAt: adjustment.createdAt.toISOString(),
        },
      },
    );
    return rows[0]?.id ?? null;
  }
}
