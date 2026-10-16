import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { OrderExportFinished } from '../application/events/order-export-finished.event';
import { decodeExportCursor, encodeExportCursor } from '../domain/export-row';
import type { ExportFailureCode } from '../domain/export-failure';
import {
  CLOCK,
  type Clock,
  type ExportJobPage,
  type ExportJobRecord,
  type ExportJobsPort,
  type FinalStatus,
} from '../domain/export-ports';
import type { ExportStatus } from '../domain/export-state';

/** How long a finished file stays downloadable (`ORDER_EXPORT_FILE_RETENTION_DAYS`, default 7). */
export const EXPORT_FILE_RETENTION_MS = Symbol('EXPORT_FILE_RETENTION_MS');
const DEFAULT_FILE_RETENTION_MS = 7 * 86_400_000;
const DELETE_CHUNK = 500;

const COLUMNS = `"id", "shopId", "createdBy", "status", "attempt", "totalRows", "rowsWritten", "bytesWritten",
  "failureCode", "fileKey", "leaseHolder", "leaseExpiresAt", "startedAt", "finishedAt", "expiresAt", "createdAt", "updatedAt"`;
const RETURNING = `RETURNING ${COLUMNS}`;

type Row = Record<string, unknown>;

const num = (value: unknown): number => Number(value);

const toRecord = (row: Row): ExportJobRecord => ({
  id: row.id as string,
  shopId: row.shopId as string,
  createdBy: row.createdBy as string,
  status: row.status as ExportStatus,
  attempt: num(row.attempt),
  totalRows: row.totalRows === null ? null : num(row.totalRows),
  rowsWritten: num(row.rowsWritten),
  bytesWritten: num(row.bytesWritten),
  failureCode: row.failureCode as ExportFailureCode | null,
  fileKey: row.fileKey as string | null,
  leaseHolder: row.leaseHolder as string | null,
  leaseExpiresAt: row.leaseExpiresAt as Date | null,
  startedAt: row.startedAt as Date | null,
  finishedAt: row.finishedAt as Date | null,
  expiresAt: row.expiresAt as Date | null,
  createdAt: row.createdAt as Date,
  updatedAt: row.updatedAt as Date,
});

/**
 * `ExportJob` and `ExportJobHistory` (S12 data-model). Every transition is one conditional `UPDATE` (status, and for
 * a worker's writes the lease holder and an unexpired lease, in the predicate) plus its history row, and for
 * DONE/FAILED/CANCELLED the `orderexport.finished` outbox entry, all in one `TransactionRunner.run`. A refused
 * conditional update returns `false`/`null` and writes nothing. Reads and the user-facing writes carry `shopId`.
 *
 * A `null` lease holder on `finish`/`requeue` is the system path (recovery): it applies only to a `RUNNING` job
 * whose lease is over.
 */
@Injectable()
export class SequelizeExportJobRepository implements ExportJobsPort {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional()
    @Inject(EXPORT_FILE_RETENTION_MS)
    private readonly fileRetentionMs: number = DEFAULT_FILE_RETENTION_MS,
  ) {}

  private select(sql: string, replacements: object = {}): Promise<Row[]> {
    return this.sequelize.query<Row>(sql, {
      type: QueryTypes.SELECT,
      replacements: replacements as Record<string, unknown>,
    });
  }

  private async history(
    job: { id: string; shopId: string },
    fromStatus: string | null,
    toStatus: string,
    reason: string | null,
    actor: string | null,
    at: Date,
  ): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "ExportJobHistory" ("exportId", "shopId", "fromStatus", "toStatus", "reason", "actor", "at")
       VALUES (:id, :shopId, :fromStatus, :toStatus, :reason, :actor, :at)`,
      {
        replacements: {
          id: job.id,
          shopId: job.shopId,
          fromStatus,
          toStatus,
          reason,
          actor,
          at,
        },
      },
    );
  }

  private async appendFinished(job: ExportJobRecord): Promise<void> {
    await this.outbox.append(
      OrderExportFinished.create(
        job.id,
        job.attempt,
        {
          exportId: job.id,
          shopId: job.shopId,
          createdBy: job.createdBy,
          status: job.status as FinalStatus,
          failureCode: job.failureCode,
          rowsWritten: job.rowsWritten,
          bytesWritten: job.bytesWritten,
          attempt: job.attempt,
          startedAt: job.startedAt ? job.startedAt.toISOString() : null,
          finishedAt: job.finishedAt!.toISOString(),
        },
        job.finishedAt!,
      ),
    );
  }

  async createWithActiveGuard(input: {
    shopId: string;
    createdBy: string;
    now: Date;
  }): Promise<
    | { kind: 'created'; job: ExportJobRecord }
    | { kind: 'active'; activeExportId: string }
  > {
    for (let attempt = 0; attempt < 3; attempt++) {
      const created = await this.runner.run(async () => {
        const rows = await this.select(
          `INSERT INTO "ExportJob" ("shopId", "createdBy", "status", "createdAt", "updatedAt")
           VALUES (:shopId, :createdBy, 'QUEUED', :now, :now)
           ON CONFLICT ("shopId") WHERE "status" IN ('QUEUED', 'RUNNING') DO NOTHING
           ${RETURNING}`,
          input,
        );
        if (!rows[0]) return null;
        const job = toRecord(rows[0]);
        await this.history(
          job,
          null,
          'QUEUED',
          null,
          input.createdBy,
          input.now,
        );
        return job;
      });
      if (created) return { kind: 'created', job: created };
      const [winner] = await this.select(
        `SELECT "id" FROM "ExportJob" WHERE "shopId" = :shopId AND "status" IN ('QUEUED', 'RUNNING')`,
        input,
      );
      if (winner)
        return { kind: 'active', activeExportId: winner.id as string };
      // the winner finished between the insert and the lookup: try again
    }
    throw new Error('export slot contention did not settle');
  }

  async findByShop(
    shopId: string,
    exportId: string,
  ): Promise<ExportJobRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "ExportJob" WHERE "shopId" = :shopId AND "id" = :exportId`,
      { shopId, exportId },
    );
    return row ? toRecord(row) : null;
  }

  async findById(exportId: string): Promise<ExportJobRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "ExportJob" WHERE "id" = :exportId`,
      { exportId },
    );
    return row ? toRecord(row) : null;
  }

  async readLease(
    exportId: string,
    leaseHolder: string,
  ): Promise<{ status: ExportStatus; leaseValid: boolean } | null> {
    const [row] = await this.select(
      `SELECT "status", ("status" = 'RUNNING' AND "leaseHolder" = :leaseHolder AND "leaseExpiresAt" > :now) AS "leaseValid"
         FROM "ExportJob" WHERE "id" = :exportId`,
      { exportId, leaseHolder, now: this.clock.now() },
    );
    return row
      ? {
          status: row.status as ExportStatus,
          leaseValid: row.leaseValid as boolean,
        }
      : null;
  }

  async list(
    shopId: string,
    query: { status?: ExportStatus; limit: number; cursor?: string },
  ): Promise<ExportJobPage> {
    const cursor = query.cursor ? decodeExportCursor(query.cursor) : null;
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "ExportJob"
        WHERE "shopId" = :shopId
          ${query.status ? `AND "status" = :status` : ''}
          ${cursor ? `AND ("createdAt", "id") < (:cursorAt::timestamptz, :cursorId::uuid)` : ''}
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT :limit`,
      {
        shopId,
        status: query.status,
        cursorAt: cursor?.createdAt,
        cursorId: cursor?.id,
        limit: query.limit + 1,
      },
    );
    const items = rows.slice(0, query.limit).map(toRecord);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeExportCursor({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  claim(input: {
    exportId: string;
    leaseHolder: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<ExportJobRecord | null> {
    return this.runner.run(async () => {
      const [row] = await this.select(
        `UPDATE "ExportJob"
            SET "status" = 'RUNNING', "attempt" = "attempt" + 1, "leaseHolder" = :leaseHolder,
                "leaseExpiresAt" = :leaseExpiresAt, "startedAt" = COALESCE("startedAt", :now), "updatedAt" = :now
          WHERE "id" = :exportId AND "status" = 'QUEUED'
          ${RETURNING}`,
        input,
      );
      if (!row) return null;
      const job = toRecord(row);
      await this.history(job, 'QUEUED', 'RUNNING', null, null, input.now);
      return job;
    });
  }

  async heartbeat(
    exportId: string,
    leaseHolder: string,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const now = this.clock.now();
    const rows = await this.select(
      `UPDATE "ExportJob" SET "leaseExpiresAt" = :leaseExpiresAt, "updatedAt" = :now
        WHERE "id" = :exportId AND "status" = 'RUNNING' AND "leaseHolder" = :leaseHolder AND "leaseExpiresAt" > :now
        RETURNING "id"`,
      { exportId, leaseHolder, leaseExpiresAt, now },
    );
    return rows.length === 1;
  }

  async recordProgress(
    exportId: string,
    leaseHolder: string,
    progress: { rowsWritten: number; bytesWritten: number; totalRows?: number },
  ): Promise<boolean> {
    const rows = await this.select(
      `UPDATE "ExportJob"
          SET "rowsWritten" = :rowsWritten, "bytesWritten" = :bytesWritten,
              "totalRows" = COALESCE(:totalRows, "totalRows"), "updatedAt" = :now
        WHERE "id" = :exportId AND "status" = 'RUNNING' AND "leaseHolder" = :leaseHolder AND "leaseExpiresAt" > :now
        RETURNING "id"`,
      {
        exportId,
        leaseHolder,
        rowsWritten: progress.rowsWritten,
        bytesWritten: progress.bytesWritten,
        totalRows: progress.totalRows ?? null,
        now: this.clock.now(),
      },
    );
    return rows.length === 1;
  }

  finish(input: {
    exportId: string;
    leaseHolder: string | null;
    to: FinalStatus;
    failureCode?: ExportFailureCode;
    fileKey?: string;
    rowsWritten: number;
    bytesWritten: number;
    now: Date;
    expiresAt?: Date;
    reason?: string;
  }): Promise<boolean> {
    const fence =
      input.leaseHolder === null
        ? `AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= :now)`
        : `AND "leaseHolder" = :leaseHolder AND "leaseExpiresAt" > :now`;
    return this.runner.run(async () => {
      const [row] = await this.select(
        `UPDATE "ExportJob"
            SET "status" = :to, "failureCode" = :failureCode, "fileKey" = COALESCE(:fileKey, "fileKey"),
                "rowsWritten" = :rowsWritten, "bytesWritten" = :bytesWritten, "finishedAt" = :now,
                "expiresAt" = :expiresAt, "leaseHolder" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = :now
          WHERE "id" = :exportId AND "status" = 'RUNNING' ${fence}
          ${RETURNING}`,
        {
          ...input,
          failureCode: input.failureCode ?? null,
          fileKey: input.fileKey ?? null,
          expiresAt:
            input.to === 'DONE'
              ? (input.expiresAt ??
                new Date(input.now.getTime() + this.fileRetentionMs))
              : null,
        },
      );
      if (!row) return false;
      const job = toRecord(row);
      await this.history(
        job,
        'RUNNING',
        input.to,
        input.reason ?? input.failureCode ?? null,
        null,
        input.now,
      );
      await this.appendFinished(job);
      return true;
    });
  }

  requeue(input: {
    exportId: string;
    leaseHolder: string | null;
    reason: string;
    restoreAttempt: boolean;
    now: Date;
  }): Promise<boolean> {
    const fence =
      input.leaseHolder === null
        ? `AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= :now)`
        : `AND "leaseHolder" = :leaseHolder AND "leaseExpiresAt" > :now`;
    return this.runner.run(async () => {
      const [row] = await this.select(
        `UPDATE "ExportJob"
            SET "status" = 'QUEUED', "leaseHolder" = NULL, "leaseExpiresAt" = NULL,
                "attempt" = CASE WHEN :restoreAttempt THEN GREATEST("attempt" - 1, 0) ELSE "attempt" END,
                "rowsWritten" = 0, "bytesWritten" = 0, "totalRows" = NULL, "updatedAt" = :now
          WHERE "id" = :exportId AND "status" = 'RUNNING' ${fence}
          ${RETURNING}`,
        input,
      );
      if (!row) return false;
      await this.history(
        toRecord(row),
        'RUNNING',
        'QUEUED',
        input.reason,
        null,
        input.now,
      );
      return true;
    });
  }

  cancel(input: {
    shopId: string;
    exportId: string;
    actor: string | null;
    reason: string;
    now: Date;
  }): Promise<ExportJobRecord | null> {
    return this.runner.run(async () => {
      const [row] = await this.select(
        `WITH old AS (
           SELECT "id", "status" FROM "ExportJob"
            WHERE "shopId" = :shopId AND "id" = :exportId AND "status" IN ('QUEUED', 'RUNNING') FOR UPDATE)
         UPDATE "ExportJob" j
            SET "status" = 'CANCELLED', "failureCode" = NULL, "finishedAt" = :now,
                "leaseHolder" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = :now
           FROM old WHERE j."id" = old."id"
         RETURNING ${COLUMNS.split(',')
           .map((c) => `j.${c.trim()}`)
           .join(', ')}, old."status" AS "fromStatus"`,
        input,
      );
      if (!row) return null;
      const job = toRecord(row);
      await this.history(
        job,
        row.fromStatus as string,
        'CANCELLED',
        input.reason,
        input.actor,
        input.now,
      );
      await this.appendFinished(job);
      return job;
    });
  }

  async findExpiredLeases(
    now: Date,
    limit: number,
  ): Promise<ExportJobRecord[]> {
    return (
      await this.select(
        `SELECT ${COLUMNS} FROM "ExportJob" WHERE "status" = 'RUNNING' AND "leaseExpiresAt" <= :now
          ORDER BY "leaseExpiresAt" LIMIT :limit`,
        { now, limit },
      )
    ).map(toRecord);
  }

  async findUnclaimed(
    olderThan: Date,
    limit: number,
  ): Promise<ExportJobRecord[]> {
    return (
      await this.select(
        `SELECT ${COLUMNS} FROM "ExportJob" WHERE "status" = 'QUEUED' AND "updatedAt" < :olderThan
          ORDER BY "updatedAt" LIMIT :limit`,
        { olderThan, limit },
      )
    ).map(toRecord);
  }

  async claimResend(
    exportId: string,
    olderThan: Date,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.select(
      `UPDATE "ExportJob" SET "updatedAt" = :now
        WHERE "id" = :exportId AND "status" = 'QUEUED' AND "updatedAt" < :olderThan
        RETURNING "id"`,
      { exportId, olderThan, now },
    );
    return rows.length === 1;
  }

  async findDoneBefore(
    cutoff: Date,
    limit: number,
  ): Promise<ExportJobRecord[]> {
    return (
      await this.select(
        `SELECT ${COLUMNS} FROM "ExportJob" WHERE "status" = 'DONE' AND "finishedAt" < :cutoff
          ORDER BY "finishedAt" LIMIT :limit`,
        { cutoff, limit },
      )
    ).map(toRecord);
  }

  markExpired(exportId: string, now: Date): Promise<boolean> {
    return this.runner.run(async () => {
      const [row] = await this.select(
        `UPDATE "ExportJob" SET "status" = 'EXPIRED', "fileKey" = NULL, "updatedAt" = :now
          WHERE "id" = :exportId AND "status" = 'DONE'
          ${RETURNING}`,
        { exportId, now },
      );
      if (!row) return false;
      await this.history(
        toRecord(row),
        'DONE',
        'EXPIRED',
        'retention',
        null,
        now,
      );
      return true;
    });
  }

  async findFinishedBefore(
    cutoff: Date,
    limit: number,
  ): Promise<ExportJobRecord[]> {
    return (
      await this.select(
        `SELECT ${COLUMNS} FROM "ExportJob"
          WHERE "status" IN ('DONE', 'FAILED', 'CANCELLED', 'EXPIRED') AND "finishedAt" < :cutoff
          ORDER BY "finishedAt" LIMIT :limit`,
        { cutoff, limit },
      )
    ).map(toRecord);
  }

  async purge(exportId: string): Promise<boolean> {
    return this.runner.run(async () => {
      await this.sequelize.query(
        `DELETE FROM "ExportJobHistory" WHERE "exportId" = :exportId`,
        { replacements: { exportId } },
      );
      const rows = await this.select(
        `DELETE FROM "ExportJob" WHERE "id" = :exportId RETURNING "id"`,
        { exportId },
      );
      return rows.length === 1;
    });
  }

  async findActiveByShop(shopId: string): Promise<ExportJobRecord[]> {
    return (
      await this.select(
        `SELECT ${COLUMNS} FROM "ExportJob" WHERE "shopId" = :shopId AND "status" IN ('QUEUED', 'RUNNING')
          ORDER BY "createdAt", "id"`,
        { shopId },
      )
    ).map(toRecord);
  }

  async deleteByShop(shopId: string): Promise<{ fileKeys: string[] }> {
    const fileKeys: string[] = [];
    for (;;) {
      const rows = await this.runner.run(async () => {
        const deleted = await this.select(
          `WITH ids AS (SELECT "id" FROM "ExportJob" WHERE "shopId" = :shopId ORDER BY "id" LIMIT :chunk),
                h AS (DELETE FROM "ExportJobHistory" WHERE "exportId" IN (SELECT "id" FROM ids))
           DELETE FROM "ExportJob" WHERE "id" IN (SELECT "id" FROM ids) RETURNING "fileKey"`,
          { shopId, chunk: DELETE_CHUNK },
        );
        return deleted;
      });
      for (const r of rows) if (r.fileKey) fileKeys.push(r.fileKey as string);
      if (rows.length < DELETE_CHUNK) break;
    }
    for (;;) {
      const rows = await this.select(
        `DELETE FROM "ExportJobHistory" WHERE "id" IN
           (SELECT "id" FROM "ExportJobHistory" WHERE "shopId" = :shopId LIMIT :chunk) RETURNING "id"`,
        { shopId, chunk: DELETE_CHUNK },
      );
      if (rows.length < DELETE_CHUNK) break;
    }
    return { fileKeys };
  }
}
