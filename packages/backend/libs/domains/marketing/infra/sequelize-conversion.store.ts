import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type {
  ConversionRow,
  ConversionStore,
  ConversionTotals,
} from '../domain/conversion-ports';

interface RawRow {
  id: string;
  linkCode: string;
  ownerId: string;
  orderId: string;
  amountMinor: string | number;
  currency: string;
  status: ConversionRow['status'];
  refundedMinor: string | number;
  orderVersion: number;
  paidAt: Date | null;
}

const COLUMNS = `"id", "linkCode", "ownerId", "orderId", "amountMinor", "currency", "status", "refundedMinor",
  "orderVersion", "paidAt"`;

const toRow = (r: RawRow): ConversionRow => ({
  ...r,
  amountMinor: Number(r.amountMinor),
  refundedMinor: Number(r.refundedMinor),
});

/**
 * `AffiliateConversion` (J05, marketing-owned): one row per credited order, found by the order id the row never exposes.
 * Statements join the caller's transaction through CLS, so the row and its outbox events commit together (IV.4).
 */
@Injectable()
export class SequelizeConversionStore implements ConversionStore {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async lockByOrder(orderId: string): Promise<ConversionRow | null> {
    const [row] = await this.sequelize.query<RawRow>(
      `SELECT ${COLUMNS} FROM "AffiliateConversion" WHERE "orderId" = :orderId FOR UPDATE`,
      { type: QueryTypes.SELECT, replacements: { orderId } },
    );
    return row ? toRow(row) : null;
  }

  /** `false` when another delivery inserted the same order first (unique `orderId`). */
  async insert(row: ConversionRow, now: Date): Promise<boolean> {
    const inserted = await this.sequelize.query(
      `INSERT INTO "AffiliateConversion" ("id", "linkCode", "ownerId", "orderId", "amountMinor", "currency", "status",
                                          "refundedMinor", "orderVersion", "paidAt", "createdAt", "updatedAt")
       VALUES (:id, :linkCode, :ownerId, :orderId, :amountMinor, :currency, :status, :refundedMinor, :orderVersion,
               :paidAt, :now, :now)
       ON CONFLICT ("orderId") DO NOTHING
       RETURNING "id"`,
      { type: QueryTypes.SELECT, replacements: { ...row, now } },
    );
    return inserted.length > 0;
  }

  async update(row: ConversionRow, now: Date): Promise<void> {
    await this.sequelize.query(
      `UPDATE "AffiliateConversion"
          SET "linkCode" = :linkCode, "ownerId" = :ownerId, "amountMinor" = :amountMinor, "currency" = :currency,
              "status" = :status, "refundedMinor" = :refundedMinor, "orderVersion" = :orderVersion,
              "paidAt" = :paidAt, "updatedAt" = :now
        WHERE "orderId" = :orderId`,
      { replacements: { ...row, now } },
    );
  }

  /** The owner's view of one link: newest first, keyset-paged on `(paidAt, id)`; pending refunds are not conversions. */
  async page(
    linkCode: string,
    limit: number,
    after: { paidAt: string; id: string } | null,
  ): Promise<ConversionRow[]> {
    const rows = await this.sequelize.query<RawRow>(
      `SELECT ${COLUMNS} FROM "AffiliateConversion"
        WHERE "linkCode" = :linkCode AND "status" <> 'PENDING_REFUND'
          AND (CAST(:afterPaidAt AS timestamptz) IS NULL
               OR ("paidAt", "id") < (CAST(:afterPaidAt AS timestamptz), CAST(:afterId AS uuid)))
        ORDER BY "paidAt" DESC, "id" DESC
        LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          linkCode,
          limit,
          afterPaidAt: after?.paidAt ?? null,
          afterId: after?.id ?? null,
        },
      },
    );
    return rows.map(toRow);
  }

  /** Confirmed conversions and their value net of refunds. */
  async totals(linkCode: string): Promise<ConversionTotals> {
    const [row] = await this.sequelize.query<{
      conversions: string | number;
      converted: string | number;
    }>(
      `SELECT count(*) AS conversions, COALESCE(sum("amountMinor" - "refundedMinor"), 0) AS converted
         FROM "AffiliateConversion" WHERE "linkCode" = :linkCode AND "status" = 'CONFIRMED'`,
      { type: QueryTypes.SELECT, replacements: { linkCode } },
    );
    return {
      conversions: Number(row?.conversions ?? 0),
      convertedMinor: Number(row?.converted ?? 0),
    };
  }
}
