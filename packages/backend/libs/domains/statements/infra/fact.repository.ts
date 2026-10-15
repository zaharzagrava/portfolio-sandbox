import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import {
  FACT_STREAMS,
  type ApplyOutcome,
  type FactRepository,
  type FactStream,
  type LedgerFactRow,
  type PayoutFactRow,
  type SaleFactRow,
} from '../domain/ports';

/**
 * The statements' own copies of the facts other capabilities announce (S16 data-model.md): sale lines append-only
 * per `(orderId, lineId, orderVersion)`, payouts version-guarded per `payoutId`, ledger journals immutable per
 * `journalId`. Every call joins the caller's transaction (CLS); values are bound parameters only.
 */
@Injectable()
export class SequelizeFactRepository implements FactRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: Record<string, unknown>,
  ) {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  private lock(key: string) {
    return this.select(
      `SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))`,
      { key },
    );
  }

  async applySaleFacts(
    orderId: string,
    orderVersion: number,
    facts: SaleFactRow[],
  ): Promise<ApplyOutcome> {
    await this.lock(`statements:order:${orderId}`);
    const [{ latest }] = await this.select<{ latest: number | null }>(
      `SELECT max("orderVersion") AS latest FROM "StatementSaleFact" WHERE "orderId" = :orderId`,
      { orderId },
    );
    if (latest !== null && latest > orderVersion) return 'stale';
    if (latest !== null && latest === orderVersion) return 'duplicate';
    if (facts.length === 0) return 'applied';
    await this.sequelize.query(
      `INSERT INTO "StatementSaleFact"
         ("orderId", "lineId", "orderVersion", "shopId", "productId", "category", "quantity", "unitPriceMinor",
          "discountMinor", "lineTotalMinor", "paidAt", "recordedAt", "appliedAt", "eventId")
       SELECT f."orderId"::uuid, f."lineId", f."orderVersion", f."shopId"::uuid, f."productId", f."category", f."quantity",
              f."unitPriceMinor", f."discountMinor", f."lineTotalMinor", f."paidAt"::timestamptz,
              f."recordedAt"::timestamptz, f."appliedAt"::timestamptz, f."eventId"::uuid
         FROM jsonb_to_recordset(CAST(:facts AS jsonb)) AS f(
           "orderId" text, "lineId" text, "orderVersion" int, "shopId" text, "productId" text, "category" text,
           "quantity" int, "unitPriceMinor" bigint, "discountMinor" bigint, "lineTotalMinor" bigint,
           "paidAt" text, "recordedAt" text, "appliedAt" text, "eventId" text)
       ON CONFLICT ("orderId", "lineId", "orderVersion") DO NOTHING`,
      {
        replacements: {
          facts: JSON.stringify(
            facts.map((f) => ({
              ...f,
              paidAt: f.paidAt.toISOString(),
              recordedAt: f.recordedAt.toISOString(),
              appliedAt: f.appliedAt.toISOString(),
            })),
          ),
        },
      },
    );
    return 'applied';
  }

  async applyPayoutFact(fact: PayoutFactRow): Promise<ApplyOutcome> {
    await this.lock(`statements:payout:${fact.payoutId}`);
    const written = await this.select<{ one: number }>(
      `INSERT INTO "StatementPayoutFact"
         ("payoutId", "shopId", "amountMinor", "paidAt", "payoutVersion", "recordedAt", "appliedAt", "eventId")
       VALUES (:payoutId, :shopId, :amountMinor, :paidAt, :payoutVersion, :recordedAt, :appliedAt, :eventId)
       ON CONFLICT ("payoutId") DO UPDATE
         SET "shopId" = EXCLUDED."shopId", "amountMinor" = EXCLUDED."amountMinor", "paidAt" = EXCLUDED."paidAt",
             "payoutVersion" = EXCLUDED."payoutVersion", "recordedAt" = EXCLUDED."recordedAt",
             "appliedAt" = EXCLUDED."appliedAt", "eventId" = EXCLUDED."eventId"
         WHERE "StatementPayoutFact"."payoutVersion" < EXCLUDED."payoutVersion"
       RETURNING 1 AS one`,
      {
        ...fact,
        paidAt: fact.paidAt.toISOString(),
        recordedAt: fact.recordedAt.toISOString(),
        appliedAt: fact.appliedAt.toISOString(),
      },
    );
    if (written.length > 0) return 'applied';
    const [stored] = await this.select<{ payoutVersion: number }>(
      `SELECT "payoutVersion" FROM "StatementPayoutFact" WHERE "payoutId" = :payoutId`,
      { payoutId: fact.payoutId },
    );
    return stored.payoutVersion === fact.payoutVersion ? 'duplicate' : 'stale';
  }

  async applyLedgerFact(fact: LedgerFactRow): Promise<ApplyOutcome> {
    const inserted = await this.select<{ one: number }>(
      `INSERT INTO "StatementLedgerFact" ("journalId", "orderId", "postedAt", "recordedAt", "appliedAt", "eventId")
       VALUES (:journalId, :orderId, :postedAt, :recordedAt, :appliedAt, :eventId)
       ON CONFLICT ("journalId") DO NOTHING RETURNING 1 AS one`,
      {
        journalId: fact.journalId,
        orderId: fact.orderId,
        postedAt: fact.postedAt.toISOString(),
        recordedAt: fact.recordedAt.toISOString(),
        appliedAt: fact.appliedAt.toISOString(),
        eventId: fact.eventId,
      },
    );
    if (inserted.length === 0) return 'duplicate';
    if (fact.credits.length > 0)
      await this.sequelize.query(
        `INSERT INTO "StatementLedgerCredit" ("journalId", "accountId", "amountMinor")
         SELECT :journalId, c."accountId", c."amountMinor"
           FROM jsonb_to_recordset(CAST(:credits AS jsonb)) AS c("accountId" text, "amountMinor" bigint)
         ON CONFLICT ("journalId", "accountId") DO NOTHING`,
        {
          replacements: {
            journalId: fact.journalId,
            credits: JSON.stringify(fact.credits),
          },
        },
      );
    return 'applied';
  }

  async advanceWatermark(
    stream: FactStream,
    occurredAt: Date,
    now: Date,
  ): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "StatementStreamWatermark" ("stream", "appliedThrough", "updatedAt")
       VALUES (:stream, :at, :now)
       ON CONFLICT ("stream") DO UPDATE
         SET "appliedThrough" = greatest("StatementStreamWatermark"."appliedThrough", EXCLUDED."appliedThrough"),
             "updatedAt" = EXCLUDED."updatedAt"`,
      {
        replacements: {
          stream,
          at: occurredAt.toISOString(),
          now: now.toISOString(),
        },
      },
    );
  }

  async readWatermarks(): Promise<Record<FactStream, Date | null>> {
    const rows = await this.select<{ stream: FactStream; at: Date | null }>(
      `SELECT "stream", "appliedThrough" AS at FROM "StatementStreamWatermark"`,
      {},
    );
    const result = Object.fromEntries(
      FACT_STREAMS.map((s) => [s, null]),
    ) as Record<FactStream, Date | null>;
    for (const row of rows) result[row.stream] = row.at ? new Date(row.at) : null;
    return result;
  }
}
