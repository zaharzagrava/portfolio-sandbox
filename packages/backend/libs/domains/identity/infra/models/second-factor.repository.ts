import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { getActiveTransaction } from '@app/infrastructure/context';
import type {
  SecondFactorRepository,
  SecondFactorRow,
} from '../../domain/ports';

interface Raw {
  userId: string;
  state: 'pending' | 'enabled';
  secretSealed: string;
  sealVersion: number;
  pendingExpiresAt: Date | null;
  enabledAt: Date | null;
  lastStep: string | number | null;
}

const toRow = (r: Raw): SecondFactorRow => ({
  userId: r.userId,
  state: r.state,
  secretSealed: r.secretSealed,
  sealVersion: Number(r.sealVersion),
  pendingExpiresAt: r.pendingExpiresAt,
  enabledAt: r.enabledAt,
  lastStep: r.lastStep == null ? null : Number(r.lastStep),
});

/**
 * Postgres adapter of `SECOND_FACTOR_REPOSITORY`, the only code that touches `SecondFactor` and `MfaRecoveryCode`
 * (III.1). Every transition is one conditional statement (III.6, III.7): the store decides who wins a race. Joins the
 * active CLS transaction when there is one.
 */
@Injectable()
export class SequelizeSecondFactorRepository implements SecondFactorRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private rows<T extends object = object>(
    sql: string,
    bind: unknown[],
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      bind,
      transaction: getActiveTransaction(),
      type: QueryTypes.SELECT,
    });
  }

  async find(userId: string, now: Date): Promise<SecondFactorRow | null> {
    const [row] = await this.rows<Raw>(
      `SELECT * FROM "SecondFactor" WHERE "userId" = $1
         AND ("state" = 'enabled' OR "pendingExpiresAt" > $2)`,
      [userId, now],
    );
    return row ? toRow(row) : null;
  }

  async enrol(input: {
    userId: string;
    secretSealed: string;
    expiresAt: Date;
    now: Date;
  }): Promise<boolean> {
    const rows = await this.rows(
      `INSERT INTO "SecondFactor"
         ("userId","state","secretSealed","sealVersion","pendingExpiresAt","createdAt","updatedAt")
       VALUES ($1,'pending',$2,1,$3,$4,$4)
       ON CONFLICT ("userId") DO UPDATE SET
         "state" = 'pending', "secretSealed" = $2, "sealVersion" = 1, "pendingExpiresAt" = $3,
         "enabledAt" = NULL, "lastStep" = NULL, "updatedAt" = $4
       WHERE "SecondFactor"."state" <> 'enabled'
       RETURNING "userId"`,
      [input.userId, input.secretSealed, input.expiresAt, input.now],
    );
    return rows.length === 1;
  }

  async confirm(userId: string, step: number, now: Date): Promise<boolean> {
    const rows = await this.rows(
      `UPDATE "SecondFactor"
         SET "state" = 'enabled', "enabledAt" = $3, "pendingExpiresAt" = NULL, "lastStep" = $2, "updatedAt" = $3
       WHERE "userId" = $1 AND "state" = 'pending' AND "pendingExpiresAt" > $3
         AND ("lastStep" IS NULL OR "lastStep" < $2)
       RETURNING "userId"`,
      [userId, step, now],
    );
    return rows.length === 1;
  }

  async acceptStep(userId: string, step: number, now: Date): Promise<boolean> {
    const rows = await this.rows(
      `UPDATE "SecondFactor" SET "lastStep" = $2, "updatedAt" = $3
       WHERE "userId" = $1 AND "state" = 'enabled' AND ("lastStep" IS NULL OR "lastStep" < $2)
       RETURNING "userId"`,
      [userId, step, now],
    );
    return rows.length === 1;
  }

  async replaceCodes(
    userId: string,
    digests: string[],
    now: Date,
  ): Promise<void> {
    await this.rows(`DELETE FROM "MfaRecoveryCode" WHERE "userId" = $1`, [
      userId,
    ]);
    await this.rows(
      `INSERT INTO "MfaRecoveryCode" ("userId","digest","createdAt")
       SELECT $1, d, $3 FROM unnest($2::text[]) AS d`,
      [userId, digests, now],
    );
  }

  async spendCode(userId: string, digest: string, now: Date): Promise<boolean> {
    const rows = await this.rows(
      `UPDATE "MfaRecoveryCode" SET "usedAt" = $3
       WHERE "userId" = $1 AND "digest" = $2 AND "usedAt" IS NULL
       RETURNING "id"`,
      [userId, digest, now],
    );
    return rows.length === 1;
  }

  async remainingCodes(userId: string): Promise<number> {
    const [row] = await this.rows<{ n: string }>(
      `SELECT count(*) AS n FROM "MfaRecoveryCode" WHERE "userId" = $1 AND "usedAt" IS NULL`,
      [userId],
    );
    return Number(row?.n ?? 0);
  }

  async disable(userId: string): Promise<boolean> {
    const rows = await this.rows(
      `DELETE FROM "SecondFactor" WHERE "userId" = $1 AND "state" = 'enabled' RETURNING "userId"`,
      [userId],
    );
    if (rows.length === 0) return false;
    await this.rows(`DELETE FROM "MfaRecoveryCode" WHERE "userId" = $1`, [
      userId,
    ]);
    return true;
  }

  async deleteAll(userId: string): Promise<'pending' | 'enabled' | null> {
    const rows = await this.rows<{ state: 'pending' | 'enabled' }>(
      `DELETE FROM "SecondFactor" WHERE "userId" = $1 RETURNING "state"`,
      [userId],
    );
    await this.rows(`DELETE FROM "MfaRecoveryCode" WHERE "userId" = $1`, [
      userId,
    ]);
    return rows[0]?.state ?? null;
  }

  async resealBatch(
    limit: number,
    reseal: (row: SecondFactorRow) => string,
    now: Date,
  ): Promise<number> {
    const batch = await this.rows<Raw>(
      `SELECT * FROM "SecondFactor" WHERE "sealVersion" = 0 ORDER BY "userId" LIMIT $1`,
      [limit],
    );
    let done = 0;
    for (const raw of batch) {
      const row = toRow(raw);
      // Conditional on the old value: a concurrent run or an enrolment in between wins and this row is skipped.
      const updated = await this.rows(
        `UPDATE "SecondFactor" SET "secretSealed" = $3, "sealVersion" = 1, "updatedAt" = $4
         WHERE "userId" = $1 AND "sealVersion" = 0 AND "secretSealed" = $2
         RETURNING "userId"`,
        [row.userId, row.secretSealed, reseal(row), now],
      );
      done += updated.length;
    }
    return done;
  }

  async purgePending(before: Date, limit: number): Promise<number> {
    const rows = await this.rows(
      `DELETE FROM "SecondFactor" WHERE "userId" IN (
         SELECT "userId" FROM "SecondFactor"
         WHERE "state" = 'pending' AND "pendingExpiresAt" < $1 LIMIT $2)
       RETURNING "userId"`,
      [before, limit],
    );
    return rows.length;
  }
}
