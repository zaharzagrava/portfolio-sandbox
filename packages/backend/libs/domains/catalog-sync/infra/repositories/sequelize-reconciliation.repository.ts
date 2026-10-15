import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import {
  MAX_FINDINGS,
  type ListPage,
  type PageQuery,
  type ReconciliationFinding,
  type ReconciliationOutcome,
  type ReconciliationRecord,
  type ReconciliationRepository,
} from '../../domain/ports';
import { KeysetCursorCodec, keysetPage } from './keyset-cursor';
import { count, json, one, toDate, toDateRequired } from './sql';

const COLUMNS = `"id", "integrationId", "startedAt", "finishedAt", "outcome", "counts", "findings", "truncated", "previousRunId"`;
const SUMMARY_COLUMNS = `t."id", t."integrationId", t."startedAt", t."finishedAt", t."outcome", t."counts",
  '[]'::jsonb AS "findings", t."truncated", t."previousRunId"`;

function toRecord(r: Record<string, unknown>): ReconciliationRecord {
  return {
    id: r.id as string,
    integrationId: r.integrationId as string,
    startedAt: toDateRequired(r.startedAt),
    finishedAt: toDate(r.finishedAt),
    outcome: (r.outcome ?? null) as ReconciliationOutcome | null,
    counts: (r.counts ?? {}) as Record<string, number>,
    findings: (r.findings ?? []) as ReconciliationFinding[],
    truncated: Boolean(r.truncated),
    previousRunId: (r.previousRunId ?? null) as string | null,
  };
}

/** `CatalogReconciliationRun` (own table; a trigger freezes a run once `finishedAt` is set, DELETE stays allowed). */
@Injectable()
export class SequelizeReconciliationRepository implements ReconciliationRepository {
  private readonly codec: KeysetCursorCodec;

  constructor(
    @InjectConnection() private readonly db: Sequelize,
    config: ApiConfigService,
  ) {
    this.codec = new KeysetCursorCodec(config.get('integration_cursor_key'));
  }

  async start(
    integrationId: string,
    startedAt: Date,
    previousRunId: string | null,
  ): Promise<string> {
    const r = await one<{ id: string }>(
      this.db,
      `INSERT INTO "CatalogReconciliationRun" ("integrationId", "startedAt", "previousRunId")
       VALUES (:integrationId, :startedAt, :previousRunId) RETURNING "id"`,
      { integrationId, startedAt, previousRunId },
    );
    return (r as { id: string }).id;
  }

  async finish(
    id: string,
    result: {
      outcome: ReconciliationOutcome;
      counts: Record<string, number>;
      findings: ReconciliationFinding[];
    },
    finishedAt: Date,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "CatalogReconciliationRun" SET "finishedAt" = :finishedAt, "outcome" = :outcome,
                "counts" = CAST(:counts AS jsonb), "findings" = CAST(:findings AS jsonb), "truncated" = :truncated
          WHERE "id" = :id AND "finishedAt" IS NULL RETURNING 1`,
        {
          id,
          finishedAt,
          outcome: result.outcome,
          counts: json(result.counts),
          findings: json(result.findings.slice(0, MAX_FINDINGS)),
          truncated: result.findings.length > MAX_FINDINGS,
        },
      )) > 0
    );
  }

  async findLatestFinished(
    integrationId: string,
  ): Promise<ReconciliationRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "CatalogReconciliationRun"
        WHERE "integrationId" = :integrationId AND "finishedAt" IS NOT NULL
        ORDER BY "startedAt" DESC, "id" DESC LIMIT 1`,
      { integrationId },
    );
    return r && toRecord(r);
  }

  async findInIntegration(
    integrationId: string,
    id: string,
  ): Promise<ReconciliationRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "CatalogReconciliationRun" WHERE "integrationId" = :integrationId AND "id" = :id`,
      { integrationId, id },
    );
    return r && toRecord(r);
  }

  listPage(
    integrationId: string,
    query: PageQuery,
  ): Promise<ListPage<ReconciliationRecord>> {
    return keysetPage({
      db: this.db,
      codec: this.codec,
      table: 'CatalogReconciliationRun',
      tsColumn: 'startedAt',
      columns: SUMMARY_COLUMNS,
      where: `t."integrationId" = :integrationId`,
      replacements: { integrationId },
      scope: `reconciliations:${integrationId}`,
      query,
      map: toRecord,
    });
  }

  purgeStartedBefore(before: Date, limit: number): Promise<number> {
    return count(
      this.db,
      `DELETE FROM "CatalogReconciliationRun"
        WHERE "id" IN (SELECT "id" FROM "CatalogReconciliationRun" WHERE "startedAt" < :before ORDER BY "startedAt" LIMIT :limit)
        RETURNING 1`,
      { before, limit },
    );
  }

  deleteByIntegration(integrationId: string): Promise<number> {
    return count(
      this.db,
      `DELETE FROM "CatalogReconciliationRun" WHERE "integrationId" = :integrationId RETURNING 1`,
      { integrationId },
    );
  }
}
