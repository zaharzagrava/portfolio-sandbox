import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import type {
  CheckedBalanceRow,
  LedgerMaintenanceStore,
} from '../domain/ledger-ports';

const BACKFILL = 'balances';
const LOCK_NOT_AVAILABLE = '55P03';

const pgCode = (error: unknown): string | undefined =>
  (error as { parent?: { code?: string }; original?: { code?: string } })
    ?.parent?.code ??
  (error as { original?: { code?: string } })?.original?.code;

interface BalanceDbRow {
  accountId: string;
  shard: number;
  currency: string;
  balanceMinor: string;
  version: string;
}
const toChecked = (r: BalanceDbRow): CheckedBalanceRow => ({
  accountId: r.accountId,
  shard: Number(r.shard),
  currency: r.currency.trim(),
  balanceMinor: Number(r.balanceMinor),
  version: Number(r.version),
});

/**
 * Postgres adapter of `LEDGER_MAINTENANCE_STORE`: the SQL of the housekeeping jobs. Every statement is bounded by the
 * window of the check (two closed days) or by a keyset batch (5 000 rows); none sums the whole book.
 */
@Injectable()
export class SequelizeLedgerMaintenanceStore implements LedgerMaintenanceStore {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
  ) {}

  /** One statement, so one transaction: the function creates, protects or rebuilds partitions all-or-nothing. */
  async ensurePartitions(
    fromMonth: string,
    monthsAhead: number,
  ): Promise<void> {
    await this.sequelize.query(
      `SELECT ledger_ensure_partitions($1::date, $2::int)`,
      { bind: [fromMonth, monthsAhead], type: QueryTypes.SELECT },
    );
  }

  async defaultPartitionRows(): Promise<number> {
    const [row] = await this.sequelize.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "LedgerEntry_default"`,
      { type: QueryTypes.SELECT },
    );
    return Number(row.n);
  }

  unbalancedJournals(from: Date, to: Date, limit: number) {
    return this.sequelize.query<{ journalId: string; sum: string }>(
      `SELECT "journalId", sum(amount)::text AS sum FROM "LedgerEntry"
        WHERE "createdAt" >= $1 AND "createdAt" < $2
        GROUP BY "journalId" HAVING sum(amount) <> 0 ORDER BY "journalId" LIMIT $3`,
      { type: QueryTypes.SELECT, bind: [from, to, limit] },
    );
  }

  balanceDrift(from: Date, to: Date, limit: number) {
    return this.sequelize.query<{
      accountId: string;
      shard: number;
      currency: string;
      expected: string;
      actual: string;
    }>(
      `WITH touched AS (
         SELECT DISTINCT "accountId", "shard", "currency" FROM "LedgerEntry"
          WHERE "createdAt" >= $1 AND "createdAt" < $2)
       SELECT t."accountId", t."shard", trim(t."currency") AS "currency",
              coalesce(b."balanceMinor", 0)::text AS "actual",
              (coalesce(c."balanceMinor", 0) + coalesce((
                 SELECT sum(e.amount) FROM "LedgerEntry" e
                  WHERE e."accountId" = t."accountId" AND e."shard" = t."shard" AND e."currency" = t."currency"
                    AND (c."verifiedThrough" IS NULL OR e."createdAt" >= c."verifiedThrough")), 0))::text AS "expected"
         FROM touched t
         LEFT JOIN "LedgerCheckpoint" c ON c."accountId" = t."accountId" AND c."shard" = t."shard" AND c."currency" = t."currency"
         LEFT JOIN "AccountBalance" b ON b."accountId" = t."accountId" AND b."shard" = t."shard" AND b."currency" = t."currency"
        WHERE coalesce(b."balanceMinor", 0) <> coalesce(c."balanceMinor", 0) + coalesce((
                 SELECT sum(e.amount) FROM "LedgerEntry" e
                  WHERE e."accountId" = t."accountId" AND e."shard" = t."shard" AND e."currency" = t."currency"
                    AND (c."verifiedThrough" IS NULL OR e."createdAt" >= c."verifiedThrough")), 0)
        ORDER BY t."accountId", t."shard" LIMIT $3`,
      { type: QueryTypes.SELECT, bind: [from, to, limit] },
    );
  }

  async touchedBalances(
    from: Date,
    to: Date,
    after: { accountId: string; shard: number; currency: string } | null,
    limit: number,
  ): Promise<CheckedBalanceRow[]> {
    const rows = await this.sequelize.query<BalanceDbRow>(
      `SELECT b."accountId", b."shard", b."currency", b."balanceMinor"::text AS "balanceMinor", b."version"::text AS "version"
         FROM "AccountBalance" b
        WHERE EXISTS (SELECT 1 FROM "LedgerEntry" e
                       WHERE e."accountId" = b."accountId" AND e."shard" = b."shard" AND e."currency" = b."currency"
                         AND e."createdAt" >= $1 AND e."createdAt" < $2)
          AND ($3::text IS NULL OR (b."accountId", b."shard", b."currency") > ($3::text, $4::smallint, $5::text))
        ORDER BY b."accountId", b."shard", b."currency" LIMIT $6`,
      {
        type: QueryTypes.SELECT,
        bind: [
          from,
          to,
          after?.accountId ?? null,
          after?.shard ?? 0,
          after?.currency ?? '',
          limit,
        ],
      },
    );
    return rows.map(toChecked);
  }

  async advanceCheckpoints(
    from: Date,
    to: Date,
    exclude: string[],
  ): Promise<number> {
    const rows = await this.sequelize.query<{ n: string }>(
      `WITH touched AS (
         SELECT DISTINCT "accountId", "shard", "currency" FROM "LedgerEntry"
          WHERE "createdAt" >= $1 AND "createdAt" < $2),
       advanced AS (
         INSERT INTO "LedgerCheckpoint" ("accountId", "shard", "currency", "verifiedThrough", "balanceMinor")
         SELECT t."accountId", t."shard", t."currency", $2,
                coalesce(c."balanceMinor", 0) + coalesce((
                  SELECT sum(e.amount) FROM "LedgerEntry" e
                   WHERE e."accountId" = t."accountId" AND e."shard" = t."shard" AND e."currency" = t."currency"
                     AND (c."verifiedThrough" IS NULL OR e."createdAt" >= c."verifiedThrough") AND e."createdAt" < $2), 0)
           FROM touched t
           LEFT JOIN "LedgerCheckpoint" c ON c."accountId" = t."accountId" AND c."shard" = t."shard" AND c."currency" = t."currency"
          WHERE (c."verifiedThrough" IS NULL OR c."verifiedThrough" < $2)
            AND NOT (t."accountId" || '|' || t."shard" || '|' || trim(t."currency")) = ANY($3::text[])
         ON CONFLICT ("accountId", "shard", "currency") DO UPDATE
           SET "verifiedThrough" = EXCLUDED."verifiedThrough", "balanceMinor" = EXCLUDED."balanceMinor"
         RETURNING 1)
       SELECT count(*)::text AS n FROM advanced`,
      { type: QueryTypes.SELECT, bind: [from, to, exclude] },
    );
    return Number(rows[0].n);
  }

  async oldestPostedAfter(after: Date): Promise<Date | null> {
    const [row] = await this.sequelize.query<{ at: Date | null }>(
      `SELECT min("postedAt") AS at FROM "LedgerJournal"
        WHERE "kind" = ANY(ARRAY['SALE','REFUND','SETTLEMENT','SWEEP','PAYOUT','PAYOUT_REVERSAL','AD_CHARGE','ADJUSTMENT'])
          AND "postedAt" > $1`,
      { type: QueryTypes.SELECT, bind: [after] },
    );
    return row?.at ? new Date(row.at) : null;
  }

  async backfillBatch(input: {
    batch: number;
    now: Date;
  }): Promise<{ rows: number; journals: number; finished: boolean }> {
    try {
      // A batch is its own transaction with a 3 s lock limit (set by the runner), never nested in the caller's.
      return await this.transactions.run(
        async (transaction) => {
          const q = <T extends object>(sql: string, bind: unknown[] = []) =>
            this.sequelize.query<T>(sql, {
              type: QueryTypes.SELECT,
              bind: bind as never,
              transaction,
            });
          await this.sequelize.query(
            `INSERT INTO "LedgerBackfillCursor" ("name") VALUES ($1) ON CONFLICT DO NOTHING`,
            { bind: [BACKFILL], transaction },
          );
          const [cursor] = await q<{
            lastCreatedAt: Date | null;
            lastId: string | null;
            finishedAt: Date | null;
          }>(
            `SELECT "lastCreatedAt", "lastId", "finishedAt" FROM "LedgerBackfillCursor" WHERE "name" = $1 FOR UPDATE`,
            [BACKFILL],
          );
          if (cursor.finishedAt)
            return { rows: 0, journals: 0, finished: true };

          const rows = await q<{
            id: string;
            journalId: string;
            createdAt: Date;
          }>(
            `SELECT "id", "journalId", "createdAt" FROM "LedgerEntry"
            WHERE ($1::timestamptz IS NULL OR ("createdAt", "id") > ($1::timestamptz, $2::uuid))
            ORDER BY "createdAt", "id" LIMIT $3`,
            [cursor.lastCreatedAt, cursor.lastId, input.batch],
          );
          if (rows.length === 0)
            return { rows: 0, journals: 0, finished: true };

          const ids = [...new Set(rows.map((r) => r.journalId))];
          // Headers for the journals of this batch that have none yet; a journal is booked by whichever batch meets it first.
          const created = await q<{ id: string }>(
            `INSERT INTO "LedgerJournal" ("id","kind","reference","currency","postedAt","fingerprint","paymentId","amountMinor","clearingMinor")
           SELECT e."journalId", min(e."kind"), e."journalId"::text, 'EUR', min(e."createdAt"),
                  encode(sha256(convert_to('EUR' || E'\\n' || string_agg(e."accountId" || '|' || e."shard" || '|' || e."amount",
                          E'\\n' ORDER BY (e."accountId" || '|' || e."shard" || '|' || e."amount") COLLATE "C"), 'UTF8')), 'hex'),
                  (array_agg(e."paymentId") FILTER (WHERE e."paymentId" IS NOT NULL))[1],
                  CASE WHEN min(e."kind") IN ('SALE','REFUND') THEN sum(e."amount") FILTER (WHERE e."amount" > 0) END,
                  CASE WHEN min(e."kind") = 'SALE' THEN sum(e."amount") FILTER (WHERE e."accountId" = 'MARKETPLACE_CLEARING' AND e."amount" > 0) END
             FROM "LedgerEntry" e
            WHERE e."journalId" = ANY($1::uuid[])
              AND NOT EXISTS (SELECT 1 FROM "LedgerJournal" j WHERE j."id" = e."journalId")
            GROUP BY e."journalId"
           ON CONFLICT DO NOTHING
           RETURNING "id"`,
            [ids],
          );
          if (created.length > 0)
            await q(
              `INSERT INTO "AccountBalance" ("accountId","shard","currency","balanceMinor","version","updatedAt")
             SELECT e."accountId", e."shard", e."currency", sum(e."amount"), count(DISTINCT e."journalId"), $2
               FROM "LedgerEntry" e WHERE e."journalId" = ANY($1::uuid[])
              GROUP BY e."accountId", e."shard", e."currency" ORDER BY e."accountId", e."shard", e."currency"
             ON CONFLICT ("accountId","shard","currency") DO UPDATE
               SET "balanceMinor" = "AccountBalance"."balanceMinor" + EXCLUDED."balanceMinor",
                   "version" = "AccountBalance"."version" + EXCLUDED."version",
                   "updatedAt" = EXCLUDED."updatedAt"
             RETURNING 1`,
              [created.map((c) => c.id), input.now],
            );
          const last = rows[rows.length - 1];
          await q(
            `UPDATE "LedgerBackfillCursor"
              SET "lastCreatedAt" = $2, "lastId" = $3, "rowsDone" = "rowsDone" + $4 WHERE "name" = $1 RETURNING 1`,
            [BACKFILL, last.createdAt, last.id, rows.length],
          );
          return {
            rows: rows.length,
            journals: created.length,
            finished: false,
          };
        },
        { lockTimeoutMs: 3_000, propagation: 'requires_new' },
      );
    } catch (error) {
      if (pgCode(error) === LOCK_NOT_AVAILABLE)
        throw new Error(
          'the backfill batch could not take its rows within 3 s; it will run again',
        );
      throw error;
    }
  }

  async backfillFinished(): Promise<boolean> {
    const [row] = await this.sequelize.query<{ finishedAt: Date | null }>(
      `SELECT "finishedAt" FROM "LedgerBackfillCursor" WHERE "name" = $1`,
      { type: QueryTypes.SELECT, bind: [BACKFILL] },
    );
    return !!row?.finishedAt;
  }

  async markBackfillFinished(now: Date): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "LedgerBackfillCursor" ("name","finishedAt") VALUES ($1,$2)
       ON CONFLICT ("name") DO UPDATE SET "finishedAt" = EXCLUDED."finishedAt"`,
      { bind: [BACKFILL, now] },
    );
  }

  async seedCheckpoints(through: Date): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "LedgerCheckpoint" ("accountId","shard","currency","verifiedThrough","balanceMinor")
       SELECT "accountId","shard","currency", $1, sum("amount") FROM "LedgerEntry"
        WHERE "createdAt" < $1 GROUP BY "accountId","shard","currency"
       ON CONFLICT ("accountId","shard","currency") DO NOTHING`,
      { bind: [through] },
    );
  }

  async balancePage(
    after: { accountId: string; shard: number; currency: string } | null,
    limit: number,
  ): Promise<CheckedBalanceRow[]> {
    const rows = await this.sequelize.query<BalanceDbRow>(
      `SELECT "accountId","shard","currency","balanceMinor"::text AS "balanceMinor","version"::text AS "version"
         FROM "AccountBalance"
        WHERE $1::text IS NULL OR ("accountId","shard","currency") > ($1::text, $2::smallint, $3::text)
        ORDER BY "accountId","shard","currency" LIMIT $4`,
      {
        type: QueryTypes.SELECT,
        bind: [
          after?.accountId ?? null,
          after?.shard ?? 0,
          after?.currency ?? '',
          limit,
        ],
      },
    );
    return rows.map(toChecked);
  }
}
