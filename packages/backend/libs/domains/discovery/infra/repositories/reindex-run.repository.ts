import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, UniqueConstraintError } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  ActiveRunExistsError,
  type NewReindexRun,
  type ReindexRunHistoryEntry,
  type ReindexRunPatch,
  type ReindexRunRecord,
  type ReindexRunRepository,
} from '../../domain/ports';
import { transition as legalMove } from '../../domain/reindex-run-status';

interface RunRow {
  runId: string;
  kind: ReindexRunRecord['kind'];
  status: ReindexRunRecord['status'];
  mappingVersion: number;
  embeddingModelVersion: string;
  index: string | null;
  previousIndex: string | null;
  previousRetiresAt: Date | null;
  replayPosition: Record<string, unknown>;
  documents: string;
  ledger: Record<string, number>;
  failureReason: string | null;
  switchingAt: Date | null;
  requestedBy: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

const COLUMNS = `"runId", "kind", "status", "mappingVersion", "embeddingModelVersion", "index", "previousIndex",
  "previousRetiresAt", "replayPosition", "documents", "ledger", "failureReason", "switchingAt", "requestedBy",
  "startedAt", "finishedAt", "createdAt"`;

const toRecord = (r: RunRow): ReindexRunRecord => ({
  ...r,
  documents: Number(r.documents),
});

/** Columns a patch may set, in one place so the statement below is built from this list only (never from input). */
const PATCHABLE = [
  'index',
  'previousIndex',
  'previousRetiresAt',
  'documents',
  'replayPosition',
  'ledger',
  'failureReason',
  'startedAt',
  'finishedAt',
] as const;

const JSON_COLUMNS = new Set(['replayPosition', 'ledger']);

/**
 * `SearchReindexRun` and its history. Every status move is `UPDATE … WHERE runId AND status = :from` asserting one row,
 * with the history row in the same transaction (III.6); at most one active run exists by a partial unique index.
 */
@Injectable()
export class SequelizeReindexRunRepository implements ReindexRunRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
  ) {}

  async insertQueued(run: NewReindexRun): Promise<ReindexRunRecord> {
    try {
      return await this.transactions.run(async (tx) => {
        const [row] = await this.sequelize.query<RunRow>(
          `INSERT INTO "SearchReindexRun"
             ("runId", "kind", "status", "mappingVersion", "embeddingModelVersion", "index", "previousIndex",
              "requestedBy", "createdAt")
           VALUES ($1, $2, 'QUEUED', $3, $4, $5, $6, $7, $8)
           RETURNING ${COLUMNS}`,
          {
            type: QueryTypes.SELECT,
            bind: [
              run.runId,
              run.kind,
              run.mappingVersion,
              run.embeddingModelVersion,
              run.index ?? null,
              run.previousIndex ?? null,
              run.requestedBy,
              run.now,
            ],
            transaction: tx,
          },
        );
        await this.sequelize.query(
          `INSERT INTO "SearchReindexRunHistory" ("runId", "fromStatus", "toStatus", "at", "detail")
           VALUES ($1, NULL, 'QUEUED', $2, $3::jsonb)`,
          {
            bind: [run.runId, run.now, JSON.stringify({ kind: run.kind })],
            transaction: tx,
          },
        );
        return toRecord(row);
      });
    } catch (error) {
      // the caller looks up the active run after its transaction has rolled back
      if (error instanceof UniqueConstraintError) throw new ActiveRunExistsError('');
      throw error;
    }
  }

  async get(runId: string): Promise<ReindexRunRecord | null> {
    const [row] = await this.sequelize.query<RunRow>(
      `SELECT ${COLUMNS} FROM "SearchReindexRun" WHERE "runId" = $1`,
      { type: QueryTypes.SELECT, bind: [runId] },
    );
    return row ? toRecord(row) : null;
  }

  async list(
    limit: number,
    cursor: { createdAt: Date; runId: string } | null,
  ): Promise<ReindexRunRecord[]> {
    const rows = await this.sequelize.query<RunRow>(
      `SELECT ${COLUMNS} FROM "SearchReindexRun"
       WHERE ($1::timestamptz IS NULL OR ("createdAt", "runId") < ($1::timestamptz, $2::uuid))
       ORDER BY "createdAt" DESC, "runId" DESC
       LIMIT $3`,
      {
        type: QueryTypes.SELECT,
        bind: [cursor?.createdAt ?? null, cursor?.runId ?? null, limit],
      },
    );
    return rows.map(toRecord);
  }

  async history(runId: string): Promise<ReindexRunHistoryEntry[]> {
    return this.sequelize.query<ReindexRunHistoryEntry>(
      `SELECT "fromStatus", "toStatus", "at", "detail" FROM "SearchReindexRunHistory"
       WHERE "runId" = $1 ORDER BY "historyId"`,
      { type: QueryTypes.SELECT, bind: [runId] },
    );
  }

  async findActive(): Promise<ReindexRunRecord | null> {
    const [row] = await this.sequelize.query<RunRow>(
      `SELECT ${COLUMNS} FROM "SearchReindexRun"
       WHERE "status" IN ('QUEUED','BUILDING','CATCHING_UP') LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    return row ? toRecord(row) : null;
  }

  async latestCompleted(): Promise<ReindexRunRecord | null> {
    const [row] = await this.sequelize.query<RunRow>(
      `SELECT ${COLUMNS} FROM "SearchReindexRun" WHERE "status" = 'COMPLETED'
       ORDER BY "finishedAt" DESC NULLS LAST, (SELECT max(h."historyId") FROM "SearchReindexRunHistory" h WHERE h."runId" = "SearchReindexRun"."runId") DESC NULLS LAST LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    return row ? toRecord(row) : null;
  }

  async retainedIndexes(): Promise<string[]> {
    const rows = await this.sequelize.query<{ index: string }>(
      `SELECT "index" FROM "SearchReindexRun"
         WHERE "status" IN ('BUILDING','CATCHING_UP') AND "index" IS NOT NULL
       UNION
       SELECT "previousIndex" AS "index" FROM (
         SELECT "previousIndex" FROM "SearchReindexRun" WHERE "status" = 'COMPLETED'
         ORDER BY "finishedAt" DESC NULLS LAST, (SELECT max(h."historyId") FROM "SearchReindexRunHistory" h WHERE h."runId" = "SearchReindexRun"."runId") DESC NULLS LAST LIMIT 1
       ) latest WHERE "previousIndex" IS NOT NULL`,
      { type: QueryTypes.SELECT },
    );
    return rows.map((r) => r.index);
  }

  async transition(
    runId: string,
    from: ReindexRunRecord['status'],
    to: ReindexRunRecord['status'],
    patch: ReindexRunPatch,
    at: Date,
    detail: Record<string, unknown> = {},
  ): Promise<ReindexRunRecord | null> {
    if (!legalMove(from, to).ok)
      throw new Error(`illegal reindex run move ${from} -> ${to}`);
    return this.transactions.run(async (tx) => {
      const { sets, bind } = this.patchSql(patch, 4);
      const [row] = await this.sequelize.query<RunRow>(
        `UPDATE "SearchReindexRun" SET "status" = $3${sets}
         WHERE "runId" = $1 AND "status" = $2
         RETURNING ${COLUMNS}`,
        {
          type: QueryTypes.SELECT,
          bind: [runId, from, to, ...bind],
          transaction: tx,
        },
      );
      if (!row) return null;
      await this.sequelize.query(
        `INSERT INTO "SearchReindexRunHistory" ("runId", "fromStatus", "toStatus", "at", "detail")
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        {
          bind: [runId, from, to, at, JSON.stringify(detail)],
          transaction: tx,
        },
      );
      return toRecord(row);
    });
  }

  async cancel(runId: string, at: Date): Promise<ReindexRunRecord | null> {
    return this.transactions.run(async (tx) => {
      const [old] = await this.sequelize.query<{ status: string }>(
        `SELECT "status" FROM "SearchReindexRun" WHERE "runId" = $1 FOR UPDATE`,
        { type: QueryTypes.SELECT, bind: [runId], transaction: tx },
      );
      if (!old) return null;
      const [row] = await this.sequelize.query<RunRow>(
        `UPDATE "SearchReindexRun" SET "status" = 'CANCELLED', "finishedAt" = $2
         WHERE "runId" = $1 AND "status" IN ('QUEUED','BUILDING','CATCHING_UP') AND "switchingAt" IS NULL
         RETURNING ${COLUMNS}`,
        { type: QueryTypes.SELECT, bind: [runId, at], transaction: tx },
      );
      if (!row) return null;
      await this.sequelize.query(
        `INSERT INTO "SearchReindexRunHistory" ("runId", "fromStatus", "toStatus", "at", "detail")
         VALUES ($1, $2, 'CANCELLED', $3, '{}'::jsonb)`,
        { bind: [runId, old.status, at], transaction: tx },
      );
      return toRecord(row);
    });
  }

  async progress(runId: string, patch: ReindexRunPatch): Promise<void> {
    const { sets, bind } = this.patchSql(patch, 2);
    if (!sets) return;
    await this.sequelize.query(
      `UPDATE "SearchReindexRun" SET ${sets.replace(/^,\s*/, '')} WHERE "runId" = $1`,
      { bind: [runId, ...bind] },
    );
  }

  async claimSwitch(runId: string, at: Date): Promise<boolean> {
    const rows = await this.sequelize.query<{ runId: string }>(
      `UPDATE "SearchReindexRun" SET "switchingAt" = $2
       WHERE "runId" = $1 AND "status" = 'CATCHING_UP' AND "switchingAt" IS NULL
       RETURNING "runId"`,
      { type: QueryTypes.SELECT, bind: [runId, at] },
    );
    return rows.length === 1;
  }

  async clearPrevious(runId: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE "SearchReindexRun" SET "previousIndex" = NULL, "previousRetiresAt" = NULL WHERE "runId" = $1`,
      { bind: [runId] },
    );
  }

  /** `, "col" = $n` fragments for the keys present, numbered from `first`; the column names come from `PATCHABLE`. */
  private patchSql(
    patch: ReindexRunPatch,
    first: number,
  ): { sets: string; bind: unknown[] } {
    const bind: unknown[] = [];
    let sets = '';
    for (const column of PATCHABLE) {
      const value = patch[column];
      if (value === undefined) continue;
      bind.push(JSON_COLUMNS.has(column) ? JSON.stringify(value) : value);
      const n = first + bind.length - 1;
      sets += `, "${column}" = $${n}${JSON_COLUMNS.has(column) ? '::jsonb' : ''}`;
    }
    return { sets, bind };
  }
}
