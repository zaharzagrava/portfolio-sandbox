import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { getActiveTransaction } from '@app/infrastructure/context';
import type { ResetTokenRepository } from '../../domain/ports';

/** Postgres adapter of `RESET_TOKEN_REPOSITORY`: the only code that touches "PasswordResetToken". Only digests are stored. */
@Injectable()
export class SequelizeResetTokenRepository implements ResetTokenRepository {
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

  async issue(input: {
    userId: string;
    digest: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void> {
    await this.rows(
      `UPDATE "PasswordResetToken" SET "usedAt" = $2
       WHERE "userId" = $1 AND "usedAt" IS NULL`,
      [input.userId, input.now],
    );
    await this.rows(
      `INSERT INTO "PasswordResetToken" ("userId","digest","expiresAt","createdAt")
       VALUES ($1,$2,$3,$4)`,
      [input.userId, input.digest, input.expiresAt, input.now],
    );
  }

  async find(digest: string, now: Date): Promise<string | null> {
    const [row] = await this.rows<{ userId: string }>(
      `SELECT "userId" FROM "PasswordResetToken"
       WHERE "digest" = $1 AND "usedAt" IS NULL AND "expiresAt" > $2`,
      [digest, now],
    );
    return row?.userId ?? null;
  }

  async consume(digest: string, now: Date): Promise<boolean> {
    const rows = await this.rows(
      `UPDATE "PasswordResetToken" SET "usedAt" = $2
       WHERE "digest" = $1 AND "usedAt" IS NULL AND "expiresAt" > $2
       RETURNING "id"`,
      [digest, now],
    );
    return rows.length === 1;
  }
}
