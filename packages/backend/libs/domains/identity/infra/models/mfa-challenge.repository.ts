import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { getActiveTransaction } from '@app/infrastructure/context';
import type { MfaChallengeRepository } from '../../domain/ports';

/** Postgres adapter of `MFA_CHALLENGE_REPOSITORY`: per-challenge attempts and the single-use marker (R-04). */
@Injectable()
export class SequelizeMfaChallengeRepository implements MfaChallengeRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private rows<T extends object>(sql: string, bind: unknown[]): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      bind,
      transaction: getActiveTransaction(),
      type: QueryTypes.SELECT,
    });
  }

  async reserveAttempt(input: {
    jti: string;
    userId: string;
    expiresAt: Date;
    max: number;
  }): Promise<number | null> {
    // The row appears with the first attempt; later attempts increment only while unspent and under the cap, so a
    // parallel burst cannot exceed `max` comparisons.
    const [row] = await this.rows<{ attempts: number }>(
      `INSERT INTO "MfaChallengeState" ("jti","userId","attempts","expiresAt")
       VALUES ($1,$2,1,$3)
       ON CONFLICT ("jti") DO UPDATE SET "attempts" = "MfaChallengeState"."attempts" + 1
       WHERE "MfaChallengeState"."spentAt" IS NULL AND "MfaChallengeState"."attempts" < $4
       RETURNING "attempts"`,
      [input.jti, input.userId, input.expiresAt, input.max],
    );
    return row ? Number(row.attempts) : null;
  }

  async spend(jti: string, now: Date): Promise<boolean> {
    const rows = await this.rows(
      `UPDATE "MfaChallengeState" SET "spentAt" = $2
       WHERE "jti" = $1 AND "spentAt" IS NULL RETURNING "jti"`,
      [jti, now],
    );
    return rows.length === 1;
  }

  async purge(before: Date, limit: number): Promise<number> {
    const rows = await this.rows(
      `DELETE FROM "MfaChallengeState" WHERE "jti" IN (
         SELECT "jti" FROM "MfaChallengeState" WHERE "expiresAt" < $1 LIMIT $2)
       RETURNING "jti"`,
      [before, limit],
    );
    return rows.length;
  }
}
