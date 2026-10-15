import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, type Transaction } from 'sequelize';
import { monthBounds, monthToDate } from '../domain/period';
import {
  DEFAULT_SHOP_KEY,
  type Aggregate,
  type AggregateRequest,
  type ShopAggregate,
  type StatementReader,
} from '../domain/ports';
import { ReplicaReads } from './replica-reads';

/**
 * Month figures priced in the store (S16 research R-3). Sale lines are the effective lines of each order at the
 * knowledge instant `K` (the highest order version recorded by `K`), month bounds are UTC instants bound as
 * parameters, and every line is joined to its best rate with a LEFT lateral, so a line no rate resolves is counted
 * (`unpriced`) and never dropped. The commission uses the integer formula of `domain/commission.ts`:
 * `(lineTotal × rateBps + 5000) / 10000` in bigint, rounded per line and summed.
 */
const RATE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT r."rateBps"
      FROM "CommissionRate" r
     WHERE r."shopKey" IN (f."shopId", CAST(:default AS uuid)) AND r."category" IN (f."category", '*')
       AND r."validPeriod" @> f."paidAt" AND r."recordedPeriod" @> CAST(:knownAt AS timestamptz)
     ORDER BY (r."shopKey" = CAST(:default AS uuid)), (r."category" = '*')
     LIMIT 1) rate ON true`;

const EFFECTIVE_LINES = `
  f."paidAt" >= CAST(:start AS timestamptz) AND f."paidAt" < CAST(:end AS timestamptz)
  AND f."recordedAt" <= CAST(:knownAt AS timestamptz)
  AND (NOT CAST(:appliedBy AS boolean) OR f."appliedAt" <= CAST(:knownAt AS timestamptz))
  AND f."orderVersion" = (
    SELECT max(g."orderVersion") FROM "StatementSaleFact" g
     WHERE g."orderId" = f."orderId" AND g."recordedAt" <= CAST(:knownAt AS timestamptz)
       AND (NOT CAST(:appliedBy AS boolean) OR g."appliedAt" <= CAST(:knownAt AS timestamptz)))`;

const FIGURES = `
  SELECT s."shopId",
         coalesce(sales.gross, 0)::text AS gross,
         coalesce(sales.commission, 0)::text AS commission,
         coalesce(sales.lines, 0) AS lines,
         coalesce(sales.unpriced, 0) AS unpriced,
         coalesce(pay.paid, 0)::text AS paid
    FROM shops s
    LEFT JOIN LATERAL (
      SELECT sum(f."lineTotalMinor") AS gross,
             sum(CASE WHEN rate."rateBps" IS NULL THEN 0
                      ELSE (f."lineTotalMinor" * rate."rateBps" + 5000) / 10000 END) AS commission,
             count(*)::int AS lines,
             (count(*) FILTER (WHERE rate."rateBps" IS NULL))::int AS unpriced
        FROM "StatementSaleFact" f ${RATE_LATERAL}
       WHERE f."shopId" = s."shopId" AND ${EFFECTIVE_LINES}) sales ON true
    LEFT JOIN LATERAL (
      SELECT sum(p."amountMinor") AS paid FROM "StatementPayoutFact" p
       WHERE p."shopId" = s."shopId"
         AND p."paidAt" >= CAST(:start AS timestamptz) AND p."paidAt" < CAST(:end AS timestamptz)
         AND p."recordedAt" <= CAST(:knownAt AS timestamptz)
         AND (NOT CAST(:appliedBy AS boolean) OR p."appliedAt" <= CAST(:knownAt AS timestamptz))) pay ON true
   ORDER BY s."shopId"`;

interface FigureRow {
  shopId: string;
  gross: string;
  commission: string;
  lines: number;
  unpriced: number;
  paid: string;
}

const toAggregate = (row: FigureRow): Aggregate => ({
  grossMinor: Number(row.gross),
  commissionMinor: Number(row.commission),
  lineCount: row.lines,
  unpricedLineCount: row.unpriced,
  payoutsPaidMinor: Number(row.paid),
});

@Injectable()
export class SequelizeStatementReader implements StatementReader {
  constructor(
    @InjectConnection() private readonly primary: Sequelize,
    private readonly replica: ReplicaReads,
  ) {}

  private bounds(month: string) {
    const { start, end } = monthBounds(month);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  async aggregate(request: AggregateRequest): Promise<Aggregate> {
    const run = (transaction?: Transaction) =>
      this.primary.query<FigureRow>(
        `WITH shops AS (SELECT CAST(:shopId AS uuid) AS "shopId") ${FIGURES}`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            shopId: request.shopId,
            ...this.bounds(request.month),
            knownAt: request.knownAt.toISOString(),
            appliedBy: request.appliedBy === true,
            default: DEFAULT_SHOP_KEY,
          },
        },
      );
    const rows =
      request.timeoutMs === undefined
        ? await run()
        : await this.primary.transaction(async (transaction) => {
            // `SET LOCAL` takes no bind parameter; the value is an integer clamped here.
            const timeout = Math.max(1, Math.floor(request.timeoutMs!));
            await this.primary.query(
              `SET LOCAL statement_timeout = ${timeout}`,
              { transaction },
            );
            return run(transaction);
          });
    return toAggregate(rows[0]);
  }

  async aggregateShops(
    month: string,
    knownAt: Date,
    afterShopId: string | null,
    limit: number,
  ): Promise<ShopAggregate[]> {
    const rows = await this.primary.query<FigureRow>(
      `WITH shops AS (
         SELECT u."shopId" FROM (
           SELECT f."shopId" FROM "StatementSaleFact" f
            WHERE f."paidAt" >= CAST(:start AS timestamptz) AND f."paidAt" < CAST(:end AS timestamptz)
              AND f."recordedAt" <= CAST(:knownAt AS timestamptz) AND f."appliedAt" <= CAST(:knownAt AS timestamptz)
           UNION
           SELECT p."shopId" FROM "StatementPayoutFact" p
            WHERE p."paidAt" >= CAST(:start AS timestamptz) AND p."paidAt" < CAST(:end AS timestamptz)
              AND p."recordedAt" <= CAST(:knownAt AS timestamptz) AND p."appliedAt" <= CAST(:knownAt AS timestamptz)
           UNION
           SELECT a."shopId" FROM "StatementAdjustment" a
            WHERE a."bookedMonth" = CAST(:monthDate AS date) AND a."createdAt" <= CAST(:knownAt AS timestamptz)
         ) u
          WHERE (CAST(:after AS uuid) IS NULL OR u."shopId" > CAST(:after AS uuid))
          ORDER BY u."shopId" LIMIT :limit) ${FIGURES}`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          ...this.bounds(month),
          monthDate: monthToDate(month),
          knownAt: knownAt.toISOString(),
          appliedBy: true,
          default: DEFAULT_SHOP_KEY,
          after: afterShopId,
          limit,
        },
      },
    );
    return rows.map((row) => ({ shopId: row.shopId, ...toAggregate(row) }));
  }

  async countUnpriced(month: string, knownAt: Date): Promise<number> {
    const [row] = await this.primary.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM "StatementSaleFact" f ${RATE_LATERAL}
        WHERE rate."rateBps" IS NULL AND ${EFFECTIVE_LINES}`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          ...this.bounds(month),
          knownAt: knownAt.toISOString(),
          appliedBy: true,
          default: DEFAULT_SHOP_KEY,
        },
      },
    );
    return row.n;
  }

  async listMonths(
    shopId: string,
    currentMonth: string,
    before: string | null,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.replica.run((db) =>
      db.query<{ month: string }>(
        `SELECT to_char(m."month", 'YYYY-MM') AS month FROM (
           SELECT CAST(:current AS date) AS "month"
           UNION SELECT p."month" FROM "AccountingPeriod" p WHERE p."status" <> 'CLOSED'
           UNION SELECT s."month" FROM "StatementSnapshot" s
                   JOIN "AccountingPeriod" p ON p."month" = s."month" AND p."status" = 'CLOSED'
                  WHERE s."shopId" = CAST(:shopId AS uuid)) m
          WHERE CAST(:before AS date) IS NULL OR m."month" < CAST(:before AS date)
          ORDER BY m."month" DESC LIMIT :limit`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            current: monthToDate(currentMonth),
            shopId,
            before: before ? monthToDate(before) : null,
            limit,
          },
        },
      ),
    );
    return rows.map((row) => row.month);
  }
}
