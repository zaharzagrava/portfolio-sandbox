import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { parseAccountId } from '../domain/account';
import { InsufficientBalance, JournalInvalid } from '../domain/ledger-errors';
import { lockWaitHistogram } from '../domain/ledger-metrics';
import type {
  AppliedBalance,
  BalanceDelta,
  BalanceStore,
} from '../domain/ledger-ports';

const NUMERIC_OUT_OF_RANGE = '22003';
const CHECK_VIOLATION = '23514';

const pgCode = (error: unknown): string | undefined =>
  (error as { parent?: { code?: string }; original?: { code?: string } })
    ?.parent?.code ??
  (error as { original?: { code?: string } })?.original?.code;

/**
 * Postgres adapter of `BALANCE_STORE` (research R-4): one statement per (account, shard, currency) row, taken in the
 * order given, each an atomic increment that also decides the non-negative guard. No `SELECT … FOR UPDATE`.
 */
@Injectable()
export class SequelizeBalanceStore implements BalanceStore {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async bound(
    tx: Transaction,
    limits: { lockTimeoutMs: number; statementTimeoutMs: number },
  ): Promise<void> {
    // Bound values, never interpolated; `true` = local to the transaction, so nothing leaks to the pool.
    await this.sequelize.query(
      `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`,
      {
        bind: [`${limits.lockTimeoutMs}ms`, `${limits.statementTimeoutMs}ms`],
        transaction: tx,
        type: QueryTypes.SELECT,
      },
    );
  }

  async apply(
    currency: string,
    deltas: BalanceDelta[],
    postedAt: Date,
    tx: Transaction,
  ): Promise<AppliedBalance[]> {
    const applied: AppliedBalance[] = [];
    for (const d of deltas) {
      const started = process.hrtime.bigint();
      try {
        applied.push(await this.applyOne(currency, d, postedAt, tx));
      } catch (error) {
        const code = pgCode(error);
        if (code === NUMERIC_OUT_OF_RANGE || code === CHECK_VIOLATION)
          throw new JournalInvalid('balance_overflow');
        throw error;
      } finally {
        lockWaitHistogram.record(
          Number(process.hrtime.bigint() - started) / 1e9,
          { accountClass: parseAccountId(d.accountId)?.cls ?? 'unknown' },
        );
      }
    }
    return applied;
  }

  private async applyOne(
    currency: string,
    d: BalanceDelta,
    postedAt: Date,
    tx: Transaction,
  ): Promise<AppliedBalance> {
    type Row = { balanceMinor: string; version: string };
    if (!d.guarded) {
      const [row] = await this.sequelize.query<Row>(
        `INSERT INTO "AccountBalance" ("accountId","shard","currency","balanceMinor","version","updatedAt")
         VALUES ($1,$2,$3,$4,1,$5)
         ON CONFLICT ("accountId","shard","currency") DO UPDATE
           SET "balanceMinor" = "AccountBalance"."balanceMinor" + EXCLUDED."balanceMinor",
               "version" = "AccountBalance"."version" + 1,
               "updatedAt" = EXCLUDED."updatedAt"
         RETURNING "balanceMinor","version"`,
        {
          type: QueryTypes.SELECT,
          transaction: tx,
          bind: [
            d.accountId,
            d.shard,
            currency,
            String(d.amountMinor),
            postedAt,
          ],
        },
      );
      return this.applied(d, row);
    }
    // Guarded: make sure the row exists, then move it only if it stays at or above zero (one atomic statement).
    await this.sequelize.query(
      `INSERT INTO "AccountBalance" ("accountId","shard","currency","balanceMinor","version","updatedAt")
       VALUES ($1,$2,$3,0,0,$4) ON CONFLICT DO NOTHING`,
      { transaction: tx, bind: [d.accountId, d.shard, currency, postedAt] },
    );
    const [row] = await this.sequelize.query<Row>(
      `UPDATE "AccountBalance"
          SET "balanceMinor" = "balanceMinor" + $4::bigint, "version" = "version" + 1, "updatedAt" = $5
        WHERE "accountId" = $1 AND "shard" = $2 AND "currency" = $3 AND "balanceMinor" + $4::bigint >= 0
        RETURNING "balanceMinor","version"`,
      {
        type: QueryTypes.SELECT,
        transaction: tx,
        bind: [d.accountId, d.shard, currency, String(d.amountMinor), postedAt],
      },
    );
    if (!row) throw new InsufficientBalance();
    return this.applied(d, row);
  }

  private applied(
    d: BalanceDelta,
    row: { balanceMinor: string; version: string },
  ): AppliedBalance {
    return {
      accountId: d.accountId,
      shard: d.shard,
      balanceMinor: Number(row.balanceMinor),
      version: Number(row.version),
    };
  }

  async read(
    accountIds: string[],
    currency: string,
    tx?: Transaction,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>(accountIds.map((id) => [id, 0]));
    if (accountIds.length === 0) return out;
    const rows = await this.sequelize.query<{
      accountId: string;
      balance: string;
    }>(
      `SELECT "accountId", SUM("balanceMinor")::text AS balance FROM "AccountBalance"
        WHERE "accountId" = ANY($1::text[]) AND "currency" = $2 GROUP BY "accountId"`,
      {
        type: QueryTypes.SELECT,
        bind: [accountIds, currency],
        transaction: tx,
      },
    );
    for (const r of rows) out.set(r.accountId, Number(r.balance));
    return out;
  }

  async listSellers(
    input: {
      currency: string;
      minMinor: number;
      limit: number;
      after?: string;
    },
    tx?: Transaction,
  ): Promise<{ accountId: string; balanceMinor: number }[]> {
    const rows = await this.sequelize.query<{
      accountId: string;
      balance: string;
    }>(
      `SELECT "accountId", SUM("balanceMinor")::text AS balance FROM "AccountBalance"
        WHERE "accountId" LIKE 'SHOP\\_%' AND "accountId" > $1 AND "currency" = $2
        GROUP BY "accountId" HAVING SUM("balanceMinor") >= $3::bigint
        ORDER BY "accountId" LIMIT $4`,
      {
        type: QueryTypes.SELECT,
        bind: [
          input.after ?? '',
          input.currency,
          String(input.minMinor),
          input.limit,
        ],
        transaction: tx,
      },
    );
    return rows.map((r) => ({
      accountId: r.accountId,
      balanceMinor: Number(r.balance),
    }));
  }

  async sweepableShards(
    accountId: string,
    currency: string,
    tx: Transaction,
  ): Promise<{ shard: number; balanceMinor: number }[]> {
    const rows = await this.sequelize.query<{
      shard: number;
      balanceMinor: string;
    }>(
      `SELECT "shard", "balanceMinor"::text AS "balanceMinor" FROM "AccountBalance"
        WHERE "accountId" = $1 AND "currency" = $2 AND "shard" > 0 AND "balanceMinor" <> 0
        ORDER BY "shard"`,
      { type: QueryTypes.SELECT, bind: [accountId, currency], transaction: tx },
    );
    return rows.map((r) => ({
      shard: Number(r.shard),
      balanceMinor: Number(r.balanceMinor),
    }));
  }
}
