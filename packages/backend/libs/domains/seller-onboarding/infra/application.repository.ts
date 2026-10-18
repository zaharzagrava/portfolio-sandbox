import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  ApplicationRecord,
  ApplicationRepository,
  RejectionReasonCode,
} from '../domain/ports';
import type { Answers } from '../domain/questionnaire';
import { count, json, one, rows } from './sql';

const COLUMNS = `"shopId", "answers", "submittedBy", "submittedAt", "status", "submissionNo", "verifiedAt", "rejectedAt", "rejectionReasonCode"`;

/** `ShopOnboarding` (own table). Never touches the shop table (IX.4). */
@Injectable()
export class SequelizeApplicationRepository implements ApplicationRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  find(shopId: string): Promise<ApplicationRecord | null> {
    return one<ApplicationRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "ShopOnboarding" WHERE "shopId" = :shopId`,
      { shopId },
    );
  }

  lock(shopId: string): Promise<ApplicationRecord | null> {
    return one<ApplicationRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "ShopOnboarding" WHERE "shopId" = :shopId FOR UPDATE`,
      { shopId },
    );
  }

  async listPendingVerification(limit: number): Promise<string[]> {
    // A superset of "all required documents approved": the policy under the application lock decides.
    const found = await rows<{ shopId: string }>(
      this.db,
      `SELECT o."shopId" FROM "ShopOnboarding" o
        WHERE o."status" = 'SUBMITTED'
          AND EXISTS (SELECT 1 FROM "ShopDocument" d
                       WHERE d."shopId" = o."shopId" AND d."submissionNo" = o."submissionNo" AND d."status" = 'APPROVED')
        ORDER BY o."submittedAt", o."shopId" LIMIT :limit`,
      { limit },
    );
    return found.map((r) => r.shopId);
  }

  async insert(input: {
    shopId: string;
    answers: Answers;
    submittedBy: string;
    now: Date;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `INSERT INTO "ShopOnboarding" ("shopId", "answers", "submittedBy", "submittedAt", "status", "submissionNo")
         VALUES (:shopId, CAST(:answers AS jsonb), :submittedBy, :now, 'SUBMITTED', 1)
         ON CONFLICT ("shopId") DO NOTHING RETURNING 1`,
        {
          shopId: input.shopId,
          answers: json(input.answers),
          submittedBy: input.submittedBy,
          now: input.now,
        },
      )) > 0
    );
  }

  async resubmit(input: {
    shopId: string;
    answers: Answers;
    submittedBy: string;
    now: Date;
  }): Promise<number | null> {
    const row = await one<{ submissionNo: number }>(
      this.db,
      `UPDATE "ShopOnboarding"
          SET "status" = 'SUBMITTED', "submissionNo" = "submissionNo" + 1, "answers" = CAST(:answers AS jsonb),
              "submittedBy" = :submittedBy, "submittedAt" = :now, "rejectedAt" = NULL,
              "rejectionReasonCode" = NULL, "rejectionReason" = NULL
        WHERE "shopId" = :shopId AND "status" = 'REJECTED' RETURNING "submissionNo"`,
      {
        shopId: input.shopId,
        answers: json(input.answers),
        submittedBy: input.submittedBy,
        now: input.now,
      },
    );
    return row ? Number(row.submissionNo) : null;
  }

  async verify(shopId: string, at: Date): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "ShopOnboarding" SET "status" = 'VERIFIED', "verifiedAt" = :at
          WHERE "shopId" = :shopId AND "status" = 'SUBMITTED' RETURNING 1`,
        { shopId, at },
      )) > 0
    );
  }

  async reject(input: {
    shopId: string;
    at: Date;
    reasonCode: RejectionReasonCode;
    reason: string;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "ShopOnboarding"
            SET "status" = 'REJECTED', "rejectedAt" = :at, "rejectionReasonCode" = :reasonCode, "rejectionReason" = :reason
          WHERE "shopId" = :shopId AND "status" = 'SUBMITTED' RETURNING 1`,
        {
          shopId: input.shopId,
          at: input.at,
          reasonCode: input.reasonCode,
          reason: input.reason,
        },
      )) > 0
    );
  }

  async erase(shopId: string): Promise<void> {
    await count(
      this.db,
      `DELETE FROM "ShopOnboarding" WHERE "shopId" = :shopId RETURNING 1`,
      { shopId },
    );
  }
}
