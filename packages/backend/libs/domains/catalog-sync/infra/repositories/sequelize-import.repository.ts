import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  ImportFailureCode,
  ImportStatus,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { ImportFinished } from '../../application/events/import-events';
import { isFinalImportStatus } from '../../domain/import-status';
import {
  type ClaimResult,
  type CommitBatchInput,
  type ImportHistoryEntry,
  type ImportJobPage,
  type ImportJobRecord,
  type ImportRepository,
  type TransitionInput,
} from '../../domain/ports';
import { KeysetCursorCodec, keysetPage } from './keyset-cursor';
import { count, one, rows, toDate, toDateRequired } from './sql';

const COLUMNS = `"id","shopId","createdBy","status","fileName","sizeBytes","storageKey","uploadHandle","slot","format",
  "headerColumns","ignoredColumns","scan","scannedAt","rowsProcessed","rowsCreated","rowsUpdated","rowsUnchanged",
  "rowsFailed","lastRow","nextByteOffset","bytesProcessed","failureCode","failureDetail","errorReportKey",
  "errorReportRows","leaseHolder","leaseExpiresAt","cancelRequestedAt","lastEnqueuedAt","startedAt","finishedAt",
  "createdAt","updatedAt"`;
const ACTIVE = `('PENDING_UPLOAD','UPLOADED','SCANNING','PROCESSING')`;
const FINAL = `('DONE','FAILED','CANCELLED','EXPIRED')`;
const RUNNABLE = `('UPLOADED','SCANNING','PROCESSING')`;
const RECOVERY_WINDOW_MS = 120_000;
const CHUNK = 500;

const prefixed = (alias: string) =>
  COLUMNS.split(',')
    .map((c) => `${alias}.${c.trim()}`)
    .join(', ');

const num = (v: unknown): number => Number(v);

export function toImportRecord(r: Record<string, unknown>): ImportJobRecord {
  return {
    id: r.id as string,
    shopId: r.shopId as string,
    createdBy: r.createdBy as string,
    status: r.status as ImportStatus,
    fileName: r.fileName as string,
    sizeBytes: num(r.sizeBytes),
    storageKey: r.storageKey as string,
    uploadHandle: (r.uploadHandle as string | null) ?? null,
    slot: r.slot === null || r.slot === undefined ? null : num(r.slot),
    format: (r.format as 'csv' | 'jsonl' | null) ?? null,
    headerColumns: (r.headerColumns as string[] | null) ?? null,
    ignoredColumns: (r.ignoredColumns as string[] | null) ?? [],
    scan: (r.scan as 'clean' | 'skipped' | null) ?? null,
    scannedAt: toDate(r.scannedAt),
    rowsProcessed: num(r.rowsProcessed),
    rowsCreated: num(r.rowsCreated),
    rowsUpdated: num(r.rowsUpdated),
    rowsUnchanged: num(r.rowsUnchanged),
    rowsFailed: num(r.rowsFailed),
    lastRow: num(r.lastRow),
    nextByteOffset: num(r.nextByteOffset),
    bytesProcessed: num(r.bytesProcessed),
    failureCode: (r.failureCode as ImportFailureCode | null) ?? null,
    failureDetail: (r.failureDetail as string | null) ?? null,
    errorReportKey: (r.errorReportKey as string | null) ?? null,
    errorReportRows: num(r.errorReportRows),
    leaseHolder: (r.leaseHolder as string | null) ?? null,
    leaseExpiresAt: toDate(r.leaseExpiresAt),
    cancelRequestedAt: toDate(r.cancelRequestedAt),
    lastEnqueuedAt: toDate(r.lastEnqueuedAt),
    startedAt: toDate(r.startedAt),
    finishedAt: toDate(r.finishedAt),
    createdAt: toDateRequired(r.createdAt),
    updatedAt: toDateRequired(r.updatedAt),
  };
}

const pgArray = (values: string[]): string =>
  `{${values
    .map((s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',')}}`;

const isUniqueViolation = (error: unknown): boolean => {
  const e = error as {
    original?: { code?: string };
    parent?: { code?: string };
  };
  return (e.original?.code ?? e.parent?.code) === '23505';
};

/**
 * `ImportJob` and `ImportJobHistory` (S07 data-model). Every status change is one conditional `UPDATE` (the status, and
 * for a runner's write the lease holder and an unexpired lease, in the predicate) plus its history row, and for a final
 * status the `catalogsync.import_finished` outbox entry, in one `TransactionRunner.run`; a refused update returns
 * `null`/`false` and writes nothing. Reads and the user-facing writes carry `shopId`. `now` is always the injected
 * application clock passed as a parameter, never `now()` in SQL, so frozen-clock tests and clock jumps behave.
 */
@Injectable()
export class SequelizeImportRepository implements ImportRepository {
  private readonly codec: KeysetCursorCodec;

  constructor(
    @InjectConnection() private readonly db: Sequelize,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ApiConfigService,
  ) {
    this.codec = new KeysetCursorCodec(config.get('integration_cursor_key'));
  }

  private async writeHistory(
    job: { id: string; shopId: string },
    from: string | null,
    to: string,
    reason: string | null,
    at: Date,
  ): Promise<void> {
    await count(
      this.db,
      `INSERT INTO "ImportJobHistory" ("importId","shopId","fromStatus","toStatus","reason","at")
       VALUES (:id, :shopId, :from, :to, :reason, :at) RETURNING 1`,
      { id: job.id, shopId: job.shopId, from, to, reason, at },
    );
  }

  private async appendFinished(job: ImportJobRecord): Promise<void> {
    await this.outbox.append(
      ImportFinished.create(
        job.id,
        0,
        {
          importId: job.id,
          shopId: job.shopId,
          createdBy: job.createdBy,
          status: job.status as 'DONE' | 'FAILED' | 'CANCELLED' | 'EXPIRED',
          failureCode: job.failureCode,
          rowsProcessed: job.rowsProcessed,
          rowsCreated: job.rowsCreated,
          rowsUpdated: job.rowsUpdated,
          rowsUnchanged: job.rowsUnchanged,
          rowsFailed: job.rowsFailed,
          startedAt: job.startedAt ? job.startedAt.toISOString() : null,
          finishedAt: job.finishedAt!.toISOString(),
        },
        job.finishedAt!,
      ),
    );
  }

  async insertPending(input: {
    id: string;
    shopId: string;
    createdBy: string;
    fileName: string;
    sizeBytes: number;
    storageKey: string;
    now: Date;
  }): Promise<{ kind: 'created'; job: ImportJobRecord } | { kind: 'cap' }> {
    // Each loser of a slot race lost to a winner, so at most three attempts fail on a conflict; one more decides.
    for (let attempt = 0; attempt < 5; attempt++) {
      const created = await this.runner.run(async () => {
        const [row] = await rows<Record<string, unknown>>(
          this.db,
          `INSERT INTO "ImportJob" ("id","shopId","createdBy","status","fileName","sizeBytes","storageKey","slot","createdAt","updatedAt")
           SELECT :id, :shopId, :createdBy, 'PENDING_UPLOAD', :fileName, :sizeBytes, :storageKey, s, :now, :now
             FROM generate_series(1, 3) AS s
            WHERE NOT EXISTS (SELECT 1 FROM "ImportJob" j
                               WHERE j."shopId" = :shopId AND j."slot" = s AND j."status" IN ${ACTIVE})
            ORDER BY s LIMIT 1
           ON CONFLICT ("shopId","slot") WHERE "status" IN ${ACTIVE} DO NOTHING
           RETURNING ${COLUMNS}`,
          input,
        );
        if (!row) return null;
        const job = toImportRecord(row);
        await this.writeHistory(job, null, 'PENDING_UPLOAD', null, input.now);
        return job;
      });
      if (created) return { kind: 'created', job: created };
      const active = await one<{ n: string }>(
        this.db,
        `SELECT count(*)::text AS n FROM "ImportJob" WHERE "shopId" = :shopId AND "status" IN ${ACTIVE}`,
        { shopId: input.shopId },
      );
      if (num(active?.n) >= 3) return { kind: 'cap' };
    }
    return { kind: 'cap' };
  }

  async setUploadHandle(
    importId: string,
    shopId: string,
    handle: string,
    now: Date,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "ImportJob" SET "uploadHandle" = :handle, "updatedAt" = :now
          WHERE "id" = :importId AND "shopId" = :shopId AND "status" = 'PENDING_UPLOAD' AND "uploadHandle" IS NULL
          RETURNING 1`,
        { importId, shopId, handle, now },
      )) === 1
    );
  }

  async findForShop(
    shopId: string,
    importId: string,
  ): Promise<ImportJobRecord | null> {
    const row = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "ImportJob" WHERE "shopId" = :shopId AND "id" = :importId`,
      { shopId, importId },
    );
    return row ? toImportRecord(row) : null;
  }

  async findById(importId: string): Promise<ImportJobRecord | null> {
    const row = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "ImportJob" WHERE "id" = :importId`,
      { importId },
    );
    return row ? toImportRecord(row) : null;
  }

  async history(importId: string): Promise<ImportHistoryEntry[]> {
    const found = await rows<{ toStatus: string; at: Date | string }>(
      this.db,
      `SELECT "toStatus", "at" FROM "ImportJobHistory" WHERE "importId" = :importId ORDER BY "id"`,
      { importId },
    );
    return found.map((r) => ({
      status: r.toStatus as ImportStatus,
      at: toDateRequired(r.at),
    }));
  }

  async list(
    shopId: string,
    query: { status?: ImportStatus; limit: number; cursor?: string },
  ): Promise<ImportJobPage> {
    return keysetPage<ImportJobRecord>({
      db: this.db,
      codec: this.codec,
      table: 'ImportJob',
      tsColumn: 'createdAt',
      where: `t."shopId" = :shopId${query.status ? ' AND t."status" = :status' : ''}`,
      replacements: { shopId, status: query.status },
      scope: `import-list:${shopId}`,
      query: { limit: query.limit, cursor: query.cursor },
      map: toImportRecord,
    });
  }

  async transition(input: TransitionInput): Promise<ImportJobRecord | null> {
    const final = isFinalImportStatus(input.to);
    const set = [`"status" = :to`, `"updatedAt" = :now`];
    if (input.to === 'SCANNING')
      set.push(`"startedAt" = COALESCE("startedAt", :now)`);
    if (input.scan) set.push(`"scan" = :scan`, `"scannedAt" = :now`);
    if (input.failure)
      set.push(
        `"failureCode" = :failureCode`,
        `"failureDetail" = :failureDetail`,
      );
    if (input.bytesProcessed !== undefined)
      set.push(`"bytesProcessed" = :bytesProcessed`);
    if (final)
      set.push(
        `"finishedAt" = :now`,
        `"leaseHolder" = NULL`,
        `"leaseExpiresAt" = NULL`,
        `"uploadHandle" = NULL`,
      );
    else if (input.clearUploadHandle) set.push(`"uploadHandle" = NULL`);
    const where = [`"id" = :importId`, `"status" = :from`];
    if (input.shopId) where.push(`"shopId" = :shopId`);
    if (input.leaseHolder)
      where.push(`"leaseHolder" = :leaseHolder`, `"leaseExpiresAt" > :now`);
    return this.runner.run(async () => {
      const [row] = await rows<Record<string, unknown>>(
        this.db,
        `UPDATE "ImportJob" SET ${set.join(', ')} WHERE ${where.join(' AND ')} RETURNING ${COLUMNS}`,
        {
          importId: input.importId,
          shopId: input.shopId,
          from: input.from,
          to: input.to,
          now: input.now,
          scan: input.scan,
          failureCode: input.failure?.code,
          failureDetail: input.failure?.detail ?? null,
          bytesProcessed: input.bytesProcessed,
          leaseHolder: input.leaseHolder,
        },
      );
      if (!row) return null;
      const job = toImportRecord(row);
      await this.writeHistory(
        job,
        input.from,
        input.to,
        input.reason ?? input.failure?.code ?? null,
        input.now,
      );
      if (final) await this.appendFinished(job);
      return job;
    });
  }

  async claim(input: {
    importId: string;
    leaseHolder: string;
    now: Date;
    leaseMs: number;
  }): Promise<ClaimResult> {
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    try {
      const claimed = await this.runner.run(async () => {
        const [row] = await rows<Record<string, unknown>>(
          this.db,
          `WITH old AS (SELECT "id", "status" FROM "ImportJob" WHERE "id" = :importId FOR UPDATE)
           UPDATE "ImportJob" j
              SET "leaseHolder" = :leaseHolder, "leaseExpiresAt" = :leaseExpiresAt, "updatedAt" = :now,
                  "status" = CASE WHEN old."status" = 'UPLOADED' THEN 'SCANNING' ELSE j."status" END,
                  "startedAt" = COALESCE(j."startedAt", :now)
             FROM old
            WHERE j."id" = old."id" AND j."status" IN ${RUNNABLE}
              AND (j."leaseHolder" IS NULL OR j."leaseExpiresAt" <= :now)
              AND NOT EXISTS (SELECT 1 FROM "ImportJob" e
                               WHERE e."shopId" = j."shopId" AND e."id" <> j."id" AND e."status" IN ${RUNNABLE}
                                 AND (e."createdAt", e."id") < (j."createdAt", j."id"))
           RETURNING ${prefixed('j')}, old."status" AS "oldStatus"`,
          { ...input, leaseExpiresAt },
        );
        if (!row) return null;
        const job = toImportRecord(row);
        if (row.oldStatus === 'UPLOADED')
          await this.writeHistory(job, 'UPLOADED', 'SCANNING', null, input.now);
        return job;
      });
      if (claimed) return { kind: 'claimed', job: claimed };
    } catch (error) {
      if (isUniqueViolation(error)) return { kind: 'busy' };
      throw error;
    }
    const current = await this.findById(input.importId);
    if (!current || current.status === 'PENDING_UPLOAD')
      return { kind: 'missing' };
    if (isFinalImportStatus(current.status))
      return { kind: 'final', job: current };
    if (
      current.leaseHolder !== null &&
      current.leaseExpiresAt !== null &&
      current.leaseExpiresAt > input.now
    )
      return { kind: 'held' };
    return { kind: 'busy' };
  }

  async renewLease(
    importId: string,
    leaseHolder: string,
    now: Date,
    leaseMs: number,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "ImportJob" SET "leaseExpiresAt" = :leaseExpiresAt, "updatedAt" = :now
          WHERE "id" = :importId AND "status" IN ('SCANNING','PROCESSING')
            AND "leaseHolder" = :leaseHolder AND "leaseExpiresAt" > :now
          RETURNING 1`,
        {
          importId,
          leaseHolder,
          now,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
        },
      )) === 1
    );
  }

  async releaseLease(importId: string, leaseHolder: string): Promise<void> {
    await rows(
      this.db,
      `UPDATE "ImportJob" SET "leaseHolder" = NULL, "leaseExpiresAt" = NULL
        WHERE "id" = :importId AND "leaseHolder" = :leaseHolder
        RETURNING 1`,
      { importId, leaseHolder },
    );
  }

  async commitBatch(
    input: CommitBatchInput,
  ): Promise<{ job: ImportJobRecord; cancelRequested: boolean } | null> {
    const header = input.header;
    const row = await one<Record<string, unknown>>(
      this.db,
      `UPDATE "ImportJob"
          SET "rowsProcessed" = "rowsProcessed" + :rowsProcessed,
              "rowsCreated" = "rowsCreated" + :rowsCreated,
              "rowsUpdated" = "rowsUpdated" + :rowsUpdated,
              "rowsUnchanged" = "rowsUnchanged" + :rowsUnchanged,
              "rowsFailed" = "rowsFailed" + :rowsFailed,
              "lastRow" = :lastRow, "nextByteOffset" = :nextByteOffset, "bytesProcessed" = :bytesProcessed,
              "errorReportRows" = "errorReportRows" + :errorReportLines,
              "format" = COALESCE("format", CAST(:format AS text)),
              "headerColumns" = COALESCE("headerColumns", CAST(:headerColumns AS text[])),
              "ignoredColumns" = CASE WHEN CAST(:format AS text) IS NOT NULL AND "format" IS NULL
                                      THEN CAST(:ignoredColumns AS text[]) ELSE "ignoredColumns" END,
              "leaseExpiresAt" = :leaseExpiresAt, "updatedAt" = :now
        WHERE "id" = :importId AND "status" = 'PROCESSING' AND "leaseHolder" = :leaseHolder
          AND "leaseExpiresAt" > :now AND "lastRow" <= :lastRow
        RETURNING ${COLUMNS}`,
      {
        importId: input.importId,
        leaseHolder: input.leaseHolder,
        now: input.now,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
        ...input.delta,
        lastRow: input.lastRow,
        nextByteOffset: input.nextByteOffset,
        bytesProcessed: input.bytesProcessed,
        errorReportLines: input.errorReportLines,
        format: header?.format ?? null,
        headerColumns: header?.headerColumns
          ? pgArray(header.headerColumns)
          : null,
        ignoredColumns: pgArray(header?.ignoredColumns ?? []),
      },
    );
    if (!row) return null;
    const job = toImportRecord(row);
    return { job, cancelRequested: job.cancelRequestedAt !== null };
  }

  async requestCancel(
    shopId: string,
    importId: string,
    now: Date,
  ): Promise<ImportJobRecord | null> {
    const row = await one<Record<string, unknown>>(
      this.db,
      `UPDATE "ImportJob"
          SET "cancelRequestedAt" = COALESCE("cancelRequestedAt", :now), "updatedAt" = :now
        WHERE "id" = :importId AND "shopId" = :shopId AND "status" IN ('SCANNING','PROCESSING')
        RETURNING ${COLUMNS}`,
      { shopId, importId, now },
    );
    return row ? toImportRecord(row) : null;
  }

  async claimRecoverable(now: Date, limit: number): Promise<ImportJobRecord[]> {
    const stale = new Date(now.getTime() - RECOVERY_WINDOW_MS);
    return (
      await rows<Record<string, unknown>>(
        this.db,
        `UPDATE "ImportJob" SET "lastEnqueuedAt" = :now
          WHERE "id" IN (
            SELECT "id" FROM "ImportJob"
             WHERE (("status" = 'UPLOADED' AND "updatedAt" <= :stale AND ("leaseHolder" IS NULL OR "leaseExpiresAt" <= :now))
                 OR ("status" IN ('SCANNING','PROCESSING') AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= :now)))
               AND ("lastEnqueuedAt" IS NULL OR "lastEnqueuedAt" <= :stale)
             ORDER BY "createdAt", "id" LIMIT :limit FOR UPDATE SKIP LOCKED)
          RETURNING ${COLUMNS}`,
        { now, stale, limit },
      )
    ).map(toImportRecord);
  }

  async stampEnqueued(importId: string, now: Date): Promise<void> {
    await rows(
      this.db,
      `UPDATE "ImportJob" SET "lastEnqueuedAt" = :now WHERE "id" = :importId RETURNING 1`,
      { importId, now },
    );
  }

  async findExpirable(now: Date, limit: number): Promise<ImportJobRecord[]> {
    return (
      await rows<Record<string, unknown>>(
        this.db,
        `SELECT ${COLUMNS} FROM "ImportJob"
          WHERE "status" = 'PENDING_UPLOAD' AND "createdAt" <= :cutoff
          ORDER BY "createdAt", "id" LIMIT :limit`,
        { cutoff: new Date(now.getTime() - 24 * 3_600_000), limit },
      )
    ).map(toImportRecord);
  }

  async findReportPurgeable(
    cutoff: Date,
    limit: number,
  ): Promise<ImportJobRecord[]> {
    return (
      await rows<Record<string, unknown>>(
        this.db,
        `SELECT ${COLUMNS} FROM "ImportJob"
          WHERE "status" IN ${FINAL} AND "finishedAt" < :cutoff AND "errorReportKey" IS NOT NULL
          ORDER BY "finishedAt", "id" LIMIT :limit`,
        { cutoff, limit },
      )
    ).map(toImportRecord);
  }

  async clearReportKey(importId: string): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "ImportJob" SET "errorReportKey" = NULL
          WHERE "id" = :importId AND "errorReportKey" IS NOT NULL AND "status" IN ${FINAL}
          RETURNING 1`,
        { importId },
      )) === 1
    );
  }

  async findRecordPurgeable(
    cutoff: Date,
    limit: number,
  ): Promise<ImportJobRecord[]> {
    return (
      await rows<Record<string, unknown>>(
        this.db,
        `SELECT ${COLUMNS} FROM "ImportJob"
          WHERE "status" IN ${FINAL} AND "finishedAt" < :cutoff
          ORDER BY "finishedAt", "id" LIMIT :limit`,
        { cutoff, limit },
      )
    ).map(toImportRecord);
  }

  deleteJob(importId: string): Promise<boolean> {
    return this.runner.run(async () => {
      await rows(
        this.db,
        `DELETE FROM "ImportJobHistory" WHERE "importId" = :importId RETURNING 1`,
        { importId },
      );
      return (
        (await count(
          this.db,
          `DELETE FROM "ImportJob" WHERE "id" = :importId AND "status" IN ${FINAL} RETURNING 1`,
          { importId },
        )) === 1
      );
    });
  }

  async setErrorReportKey(importId: string, key: string): Promise<void> {
    await rows(
      this.db,
      `UPDATE "ImportJob" SET "errorReportKey" = :key WHERE "id" = :importId RETURNING 1`,
      { importId, key },
    );
  }

  async nonFinalByShop(shopId: string): Promise<ImportJobRecord[]> {
    return (
      await rows<Record<string, unknown>>(
        this.db,
        `SELECT ${COLUMNS} FROM "ImportJob" WHERE "shopId" = :shopId AND "status" IN ${ACTIVE}
          ORDER BY "createdAt", "id"`,
        { shopId },
      )
    ).map(toImportRecord);
  }

  async deleteByShop(shopId: string): Promise<number> {
    let removed = 0;
    for (;;) {
      const deleted = await this.runner.run(() =>
        rows<{ id: string }>(
          this.db,
          `WITH ids AS (SELECT "id" FROM "ImportJob" WHERE "shopId" = :shopId ORDER BY "id" LIMIT :chunk),
                h AS (DELETE FROM "ImportJobHistory" WHERE "importId" IN (SELECT "id" FROM ids))
           DELETE FROM "ImportJob" WHERE "id" IN (SELECT "id" FROM ids) RETURNING "id"`,
          { shopId, chunk: CHUNK },
        ),
      );
      removed += deleted.length;
      if (deleted.length < CHUNK) break;
    }
    for (;;) {
      const left = await rows<{ id: string }>(
        this.db,
        `DELETE FROM "ImportJobHistory" WHERE "id" IN
           (SELECT "id" FROM "ImportJobHistory" WHERE "shopId" = :shopId LIMIT :chunk) RETURNING "id"`,
        { shopId, chunk: CHUNK },
      );
      if (left.length < CHUNK) break;
    }
    return removed;
  }

  async oldestCheckpointAgeMs(now: Date): Promise<number | null> {
    const row = await one<{ oldest: Date | string | null }>(
      this.db,
      `SELECT min("updatedAt") AS oldest FROM "ImportJob" WHERE "status" = 'PROCESSING'`,
    );
    return row?.oldest
      ? now.getTime() - toDateRequired(row.oldest).getTime()
      : null;
  }
}
