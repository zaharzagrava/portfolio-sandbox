import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { PayoutAuditRepository } from '../domain/payout-ports';

/** The daily audit marker and its findings (S15 data-model.md): a finding is inserted once per `(payout, kind)`. */
@Injectable()
export class SequelizePayoutAuditRepository implements PayoutAuditRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async startDay(day: string, now: Date): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "PayoutAuditDay" ("day", "status", "checked", "discrepancies", "startedAt", "finishedAt")
       VALUES (:day, 'RUNNING', 0, 0, :now, NULL)
       ON CONFLICT ("day") DO UPDATE SET "status" = 'RUNNING', "checked" = 0, "discrepancies" = 0,
         "startedAt" = :now, "finishedAt" = NULL`,
      { replacements: { day, now } },
    );
  }

  async finishDay(
    day: string,
    result: {
      status: 'COMPLETED' | 'FAILED';
      checked: number;
      discrepancies: number;
    },
    now: Date,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE "PayoutAuditDay" SET "status" = :status, "checked" = :checked, "discrepancies" = :discrepancies,
              "finishedAt" = :now WHERE "day" = :day`,
      { replacements: { ...result, day, now } },
    );
  }

  async insertFinding(
    payoutId: string,
    kind: string,
    day: string,
    now: Date,
    tx: Transaction,
  ): Promise<boolean> {
    const rows = await this.sequelize.query<{ payoutId: string }>(
      `INSERT INTO "PayoutAuditFinding" ("payoutId", "kind", "day", "foundAt")
       VALUES (:payoutId, :kind, :day, :now) ON CONFLICT DO NOTHING RETURNING "payoutId"`,
      {
        type: QueryTypes.SELECT,
        transaction: tx,
        replacements: { payoutId, kind, day, now },
      },
    );
    return rows.length === 1;
  }
}
