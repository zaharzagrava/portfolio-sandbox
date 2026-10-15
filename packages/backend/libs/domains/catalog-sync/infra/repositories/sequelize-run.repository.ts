import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  RunRepository,
  SyncCounters,
  SyncRunKind,
  SyncRunOutcome,
  SyncRunRecord,
} from '../../domain/ports';
import { count, json, one, rows, toDate, toDateRequired } from './sql';

/** `SyncRun` (own table). */
@Injectable()
export class SequelizeRunRepository implements RunRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async start(
    integrationId: string,
    kind: SyncRunKind,
    startedAt: Date,
  ): Promise<string> {
    const r = await one<{ id: string }>(
      this.db,
      `INSERT INTO "SyncRun" ("integrationId", "kind", "startedAt") VALUES (:integrationId, :kind, :startedAt)
       RETURNING "id"`,
      { integrationId, kind, startedAt },
    );
    return (r as { id: string }).id;
  }

  async finish(
    id: string,
    result: {
      outcome: SyncRunOutcome;
      counters: Partial<SyncCounters>;
      detail?: string | null;
    },
    finishedAt: Date,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "SyncRun" SET "finishedAt" = :finishedAt, "outcome" = :outcome,
                "counters" = CAST(:counters AS jsonb), "detail" = left(CAST(:detail AS text), 200)
          WHERE "id" = :id AND "finishedAt" IS NULL RETURNING 1`,
        {
          id,
          finishedAt,
          outcome: result.outcome,
          counters: json(result.counters),
          detail: result.detail ?? null,
        },
      )) > 0
    );
  }

  async listRecent(
    integrationId: string,
    limit: number,
  ): Promise<SyncRunRecord[]> {
    const found = await rows<Record<string, unknown>>(
      this.db,
      `SELECT "id", "integrationId", "kind", "startedAt", "finishedAt", "outcome", "counters", "detail"
         FROM "SyncRun" WHERE "integrationId" = :integrationId
        ORDER BY "startedAt" DESC, "id" DESC LIMIT :limit`,
      { integrationId, limit },
    );
    return found.map((r) => ({
      id: r.id as string,
      integrationId: r.integrationId as string,
      kind: r.kind as SyncRunKind,
      startedAt: toDateRequired(r.startedAt),
      finishedAt: toDate(r.finishedAt),
      outcome: (r.outcome ?? null) as SyncRunOutcome | null,
      counters: (r.counters ?? {}) as Partial<SyncCounters>,
      detail: (r.detail ?? null) as string | null,
    }));
  }

  purgeStartedBefore(before: Date, limit: number): Promise<number> {
    return count(
      this.db,
      `DELETE FROM "SyncRun" WHERE "id" IN (SELECT "id" FROM "SyncRun" WHERE "startedAt" < :before ORDER BY "startedAt" LIMIT :limit)
       RETURNING 1`,
      { before, limit },
    );
  }
}
