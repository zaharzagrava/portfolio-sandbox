import { Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { monthBounds } from '../domain/period';
import {
  DEFAULT_SHOP_KEY,
  type ExportSource,
  type SaleExportRequest,
  type SaleExportRow,
} from '../domain/ports';
import { ReplicaReads } from './replica-reads';
import { iso } from './sql';

interface Row {
  orderId: string;
  lineId: string;
  paidAt: string;
  productId: string;
  category: string;
  quantity: number;
  unitPriceMinor: string;
  lineTotalMinor: string;
  rateBps: number | null;
  commissionMinor: string | null;
}

/**
 * Priced sale lines for the CSV, one keyset batch at a time (S16 research R-7). Between batches no connection is held,
 * so a slow reader or a vanished client costs the database nothing; each batch runs in a read-only transaction on the
 * reporting replica with its own `statement_timeout`. The pricing is the one of `StatementReader`: effective lines at
 * the knowledge instant joined to their best rate, a line without a rate carries empty `rateBps` and commission.
 */
@Injectable()
export class SequelizeExportSource implements ExportSource {
  constructor(private readonly replica: ReplicaReads) {}

  async saleBatch(request: SaleExportRequest): Promise<SaleExportRow[]> {
    const { start, end } = monthBounds(request.month);
    const rows = await this.replica.run((db) =>
      db.transaction(async (transaction) => {
        // `SET LOCAL` takes no bind parameter; the value is an integer clamped here.
        const timeout = Math.max(1, Math.floor(request.timeoutMs));
        await db.query(`SET LOCAL statement_timeout = ${timeout}`, { transaction });
        return db.query<Row>(
          `SELECT f."orderId", f."lineId", ${iso('f."paidAt"')} AS "paidAt", f."productId", f."category", f."quantity",
                  f."unitPriceMinor"::text AS "unitPriceMinor", f."lineTotalMinor"::text AS "lineTotalMinor",
                  rate."rateBps" AS "rateBps",
                  CASE WHEN rate."rateBps" IS NULL THEN NULL
                       ELSE ((f."lineTotalMinor" * rate."rateBps" + 5000) / 10000)::text END AS "commissionMinor"
             FROM "StatementSaleFact" f
             LEFT JOIN LATERAL (
               SELECT r."rateBps" FROM "CommissionRate" r
                WHERE r."shopKey" IN (f."shopId", CAST(:default AS uuid)) AND r."category" IN (f."category", '*')
                  AND r."validPeriod" @> f."paidAt" AND r."recordedPeriod" @> CAST(:knownAt AS timestamptz)
                ORDER BY (r."shopKey" = CAST(:default AS uuid)), (r."category" = '*') LIMIT 1) rate ON true
            WHERE f."shopId" = CAST(:shopId AS uuid)
              AND f."paidAt" >= CAST(:start AS timestamptz) AND f."paidAt" < CAST(:end AS timestamptz)
              AND f."recordedAt" <= CAST(:knownAt AS timestamptz)
              AND (NOT CAST(:appliedBy AS boolean) OR f."appliedAt" <= CAST(:knownAt AS timestamptz))
              AND f."orderVersion" = (
                SELECT max(g."orderVersion") FROM "StatementSaleFact" g
                 WHERE g."orderId" = f."orderId" AND g."recordedAt" <= CAST(:knownAt AS timestamptz)
                   AND (NOT CAST(:appliedBy AS boolean) OR g."appliedAt" <= CAST(:knownAt AS timestamptz)))
              AND (CAST(:afterPaidAt AS timestamptz) IS NULL
                   OR (f."paidAt", f."orderId", f."lineId") > (CAST(:afterPaidAt AS timestamptz), CAST(:afterOrderId AS uuid), CAST(:afterLineId AS text)))
            ORDER BY f."paidAt", f."orderId", f."lineId"
            LIMIT :limit`,
          {
            type: QueryTypes.SELECT,
            transaction,
            replacements: {
              default: DEFAULT_SHOP_KEY,
              shopId: request.shopId,
              start: start.toISOString(),
              end: end.toISOString(),
              knownAt: request.knownAt.toISOString(),
              appliedBy: request.appliedBy,
              afterPaidAt: request.after?.paidAt ?? null,
              afterOrderId: request.after?.orderId ?? null,
              afterLineId: request.after?.lineId ?? null,
              limit: request.limit,
            },
          },
        );
      }),
    );
    return rows.map((row) => ({
      orderId: row.orderId,
      lineId: row.lineId,
      paidAt: row.paidAt,
      productId: row.productId,
      category: row.category,
      quantity: row.quantity,
      unitPriceMinor: Number(row.unitPriceMinor),
      lineTotalMinor: Number(row.lineTotalMinor),
      rateBps: row.rateBps,
      commissionMinor:
        row.commissionMinor === null ? null : Number(row.commissionMinor),
    }));
  }
}
