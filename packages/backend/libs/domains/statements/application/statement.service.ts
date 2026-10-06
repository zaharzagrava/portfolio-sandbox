import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { DEFAULT_SHOP_KEY } from './commission-rate.service';

export interface StatementTotals {
  shopId: string;
  gross: number;
  commission: number;
  net: number;
  lines: number;
}

export interface Statement extends StatementTotals {
  month: string;
  source: 'snapshot' | 'live' | 'as-known-at';
  knownAt?: string;
  adjustments: { commissionDelta: number; reason: string; bookedMonth: string }[];
}

const PAID_STATUSES = `('PAID','FULFILLING','SHIPPED','DELIVERED')`;

/**
 * Seller statements (SD-41). Each paid line is priced with the commission rate
 * that was VALID at order time, AS KNOWN at `knownAt` - one LATERAL lookup per
 * line against the bitemporal table (GiST index). Closed months are served
 * from snapshots; corrections arrive as adjustment rows booked in the open
 * month (lesson 10/02 Ex5) - a statement a seller downloaded never changes.
 * At market scale this query runs on ClickHouse over CDC'd order lines; the
 * SQL shape is the same.
 */
@Injectable()
export class StatementService {
  private readonly logger = new Logger(StatementService.name);

  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  /** Live computation for one month; `shopId` null = every shop (used by month close). */
  async compute(month: string, knownAt: Date, shopId: string | null): Promise<StatementTotals[]> {
    const rows = await this.sequelize.query<{ shopId: string; gross: string; commission: string; lines: number }>(
      `SELECT i."shopId",
              sum(i."priceAtPurchase" * i.quantity)::bigint AS gross,
              sum(round(i."priceAtPurchase" * i.quantity * r."rateBps" / 10000.0))::bigint AS commission,
              count(*)::int AS lines
       FROM "BisOrderItem" i
       JOIN "BisOrder" o ON o.id = i."bisOrderId"
       JOIN "Product" p ON p.id = i."productId"
       CROSS JOIN LATERAL (
         SELECT cr."rateBps" FROM "CommissionRate" cr
         WHERE cr."shopKey" IN (i."shopId", CAST(:default AS uuid)) AND cr.category IN (p.category, '*')
           AND cr."validPeriod" @> o."createdAt" AND cr."recordedPeriod" @> CAST(:knownAt AS timestamptz)
         ORDER BY (cr."shopKey" = CAST(:default AS uuid)), (cr.category = '*') LIMIT 1
       ) r
       WHERE o.status IN ${PAID_STATUSES} AND i."shopId" IS NOT NULL
         AND o."createdAt" >= CAST(:month AS date) AND o."createdAt" < CAST(:month AS date) + interval '1 month'
         AND (CAST(:shopId AS uuid) IS NULL OR i."shopId" = CAST(:shopId AS uuid))
       GROUP BY i."shopId"`,
      { type: QueryTypes.SELECT, replacements: { default: DEFAULT_SHOP_KEY, knownAt: knownAt.toISOString(), month, shopId } },
    );
    return rows.map((r) => ({ shopId: r.shopId, gross: Number(r.gross), commission: Number(r.commission), net: Number(r.gross) - Number(r.commission), lines: r.lines }));
  }

  async statement(shopId: string, month: string, knownAt?: Date): Promise<Statement> {
    const empty = { shopId, gross: 0, commission: 0, net: 0, lines: 0 };
    const adjustments = await this.sequelize.query<{ commissionDelta: string; reason: string; bookedMonth: string }>(
      `SELECT "commissionDelta", reason, "bookedMonth"::text FROM "StatementAdjustment" WHERE "shopId" = :shopId AND "refersToMonth" = CAST(:month AS date) ORDER BY "createdAt"`,
      { type: QueryTypes.SELECT, replacements: { shopId, month } },
    );
    const adj = adjustments.map((a) => ({ ...a, commissionDelta: Number(a.commissionDelta) }));

    if (knownAt) {
      const [totals] = await this.compute(month, knownAt, shopId);
      return { ...(totals ?? empty), month, source: 'as-known-at', knownAt: knownAt.toISOString(), adjustments: [] };
    }

    const [period] = await this.sequelize.query<{ status: string }>(`SELECT status FROM "AccountingPeriod" WHERE month = CAST(:month AS date)`, {
      type: QueryTypes.SELECT,
      replacements: { month },
    });
    if (period?.status === 'CLOSED') {
      const [snap] = await this.sequelize.query<{ gross: string; commission: string; net: string; lines: number }>(
        `SELECT gross, commission, net, lines FROM "StatementSnapshot" WHERE "shopId" = :shopId AND month = CAST(:month AS date)`,
        { type: QueryTypes.SELECT, replacements: { shopId, month } },
      );
      const totals = snap ? { shopId, gross: Number(snap.gross), commission: Number(snap.commission), net: Number(snap.net), lines: snap.lines } : empty;
      return { ...totals, month, source: 'snapshot', adjustments: adj };
    }

    const [live] = await this.compute(month, new Date(), shopId);
    return { ...(live ?? empty), month, source: 'live', adjustments: adj };
  }

  /** Month close: one snapshot row per shop, then the period is locked. Idempotent. */
  async closeMonth(month: string): Promise<number> {
    return this.sequelize.transaction(async (transaction) => {
      await this.sequelize.query(`SELECT pg_advisory_xact_lock(hashtext('statements.close:' || :month))`, { replacements: { month }, transaction });
      const [period] = await this.sequelize.query<{ status: string }>(
        `INSERT INTO "AccountingPeriod" (month) VALUES (CAST(:month AS date)) ON CONFLICT (month) DO UPDATE SET month = EXCLUDED.month RETURNING status`,
        { type: QueryTypes.SELECT, replacements: { month }, transaction },
      );
      if (period.status === 'CLOSED') return 0;

      const totals = await this.compute(month, new Date(), null);
      for (let i = 0; i < totals.length; i += 1_000) {
        const chunk = totals.slice(i, i + 1_000);
        await this.sequelize.query(
          `INSERT INTO "StatementSnapshot" ("shopId", month, gross, commission, net, lines)
           SELECT * FROM unnest(CAST(:shops AS uuid[]), CAST(:months AS date[]), CAST(:gross AS bigint[]), CAST(:commission AS bigint[]), CAST(:net AS bigint[]), CAST(:lines AS int[]))
           ON CONFLICT DO NOTHING`,
          {
            replacements: {
              shops: `{${chunk.map((t) => t.shopId).join(',')}}`,
              months: `{${chunk.map(() => month).join(',')}}`,
              gross: `{${chunk.map((t) => t.gross).join(',')}}`,
              commission: `{${chunk.map((t) => t.commission).join(',')}}`,
              net: `{${chunk.map((t) => t.net).join(',')}}`,
              lines: `{${chunk.map((t) => t.lines).join(',')}}`,
            },
            transaction,
          },
        );
      }
      await this.sequelize.query(`UPDATE "AccountingPeriod" SET status = 'CLOSED', "closedAt" = now() WHERE month = CAST(:month AS date)`, { replacements: { month }, transaction });
      return totals.length;
    });
  }

  /**
   * A rate change reached back into CLOSED months: recompute those months with
   * today's knowledge, compare with snapshot + earlier adjustments, and book
   * the difference in the currently open month. Unique per (shop, month, reason)
   * → re-running the job never double-books.
   */
  async retroAdjust(input: { shopKey: string; from: string; to: string | null; reason: string }): Promise<number> {
    const closed = await this.sequelize.query<{ month: string }>(
      `SELECT month::text FROM "AccountingPeriod" WHERE status = 'CLOSED'
         AND tstzrange(month, month + interval '1 month') && tstzrange(CAST(:from AS timestamptz), CAST(:to AS timestamptz))
       ORDER BY month`,
      { type: QueryTypes.SELECT, replacements: { from: input.from, to: input.to } },
    );
    const bookedMonth = new Date().toISOString().slice(0, 7) + '-01';
    let booked = 0;

    for (const { month } of closed) {
      const shopFilter = input.shopKey === DEFAULT_SHOP_KEY ? null : input.shopKey;
      for (const current of await this.compute(month, new Date(), shopFilter)) {
        const [{ before }] = await this.sequelize.query<{ before: string }>(
          `SELECT coalesce((SELECT commission FROM "StatementSnapshot" WHERE "shopId" = :shopId AND month = CAST(:month AS date)), 0)
                + coalesce((SELECT sum("commissionDelta") FROM "StatementAdjustment" WHERE "shopId" = :shopId AND "refersToMonth" = CAST(:month AS date)), 0) AS before`,
          { type: QueryTypes.SELECT, replacements: { shopId: current.shopId, month } },
        );
        const delta = current.commission - Number(before);
        if (delta === 0) continue;
        await this.sequelize.query(
          `INSERT INTO "StatementAdjustment" ("shopId", "bookedMonth", "refersToMonth", "commissionDelta", reason)
           VALUES (:shopId, CAST(:booked AS date), CAST(:month AS date), :delta, :reason) ON CONFLICT DO NOTHING`,
          { replacements: { shopId: current.shopId, booked: bookedMonth, month, delta, reason: input.reason } },
        );
        booked++;
      }
    }
    if (booked) this.logger.log(`retro adjustment "${input.reason}": ${booked} shop-months`);
    return booked;
  }
}
