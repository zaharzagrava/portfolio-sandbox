import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { PlanStateRepository } from '../domain/ports';
import type { PlanTier, Subject } from '../domain/types';
import { select } from './sql';

/**
 * The per-shop tier counter (S17 research R-10). One upsert decides everything: it inserts version 1 for a shop that
 * was never announced, and otherwise bumps the version only when the tier differs. The row lock the upsert takes makes
 * versions consecutive under concurrent changes.
 */
@Injectable()
export class SequelizePlanStateRepository implements PlanStateRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async bump(
    subject: Subject,
    tier: PlanTier,
    now: Date,
  ): Promise<number | null> {
    const [row] = await select<{ planVersion: number }>(
      this.sequelize,
      `INSERT INTO "SubjectPlanState" ("subjectType", "subjectId", "tier", "planVersion", "updatedAt")
       VALUES (:subjectType, :subjectId, :tier, 1, :now)
       ON CONFLICT ("subjectType", "subjectId") DO UPDATE
          SET "tier" = EXCLUDED."tier", "planVersion" = "SubjectPlanState"."planVersion" + 1, "updatedAt" = :now
        WHERE "SubjectPlanState"."tier" <> EXCLUDED."tier"
       RETURNING "planVersion"`,
      {
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        tier,
        now,
      },
    );
    return row?.planVersion ?? null;
  }
}
