import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  PayoutRunRecord,
  PayoutRunRepository,
} from '../domain/payout-ports';

/** The run record of each period: one row, moved by every execution (S15 data-model.md "PayoutRun"). */
@Injectable()
export class SequelizePayoutRunRepository implements PayoutRunRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async start(periodStart: string, now: Date): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "PayoutRun" ("periodStart", "status", "created", "existing", "skipped", "failureCode", "startedAt", "finishedAt", "updatedAt")
       VALUES (:periodStart, 'RUNNING', 0, 0, '{}', NULL, :now, NULL, :now)
       ON CONFLICT ("periodStart") DO UPDATE SET "status" = 'RUNNING', "created" = 0, "existing" = 0, "skipped" = '{}',
         "failureCode" = NULL, "startedAt" = :now, "finishedAt" = NULL, "updatedAt" = :now`,
      { replacements: { periodStart, now } },
    );
  }

  async finish(
    periodStart: string,
    result: {
      status: 'COMPLETED' | 'FAILED';
      created: number;
      existing: number;
      skipped: Record<string, number>;
      failureCode: string | null;
    },
    now: Date,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE "PayoutRun" SET "status" = :status, "created" = :created, "existing" = :existing,
              "skipped" = CAST(:skipped AS jsonb), "failureCode" = :failureCode, "finishedAt" = :now, "updatedAt" = :now
        WHERE "periodStart" = :periodStart`,
      {
        replacements: {
          ...result,
          skipped: JSON.stringify(result.skipped),
          periodStart,
          now,
        },
      },
    );
  }

  async list(page: {
    limit: number;
    after?: string;
  }): Promise<PayoutRunRecord[]> {
    return this.sequelize.query<PayoutRunRecord>(
      `SELECT "periodStart"::text AS "periodStart", "status", "created", "existing", "skipped", "failureCode",
              "startedAt", "finishedAt"
         FROM "PayoutRun" ${page.after ? `WHERE "periodStart" < CAST(:after AS date)` : ''}
        ORDER BY "periodStart" DESC LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: { limit: page.limit, after: page.after },
      },
    );
  }
}
