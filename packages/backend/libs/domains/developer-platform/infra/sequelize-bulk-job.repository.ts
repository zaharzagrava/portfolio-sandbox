import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { bulkStatus, chunkCount } from '../domain/bulk-chunking';
import {
  BulkChunkMessageBody,
  BulkFailure,
  BulkJobRecord,
  BulkJobRepository,
} from '../domain/ports';

export const BULK_CHUNK_QUEUE = 'public-api-bulk-chunk';
export const BULK_CHUNK_TASK = 'public-api.bulk_chunk';
export const BULK_RETENTION_MS = 7 * 86_400_000;
const FAILURES_KEPT = 1_000;

interface JobRow {
  id: string;
  shopId: string;
  total: number;
  chunks: number;
  completedChunks: number;
  applied: number;
  replayed: number;
  failed: number;
  failures: BulkFailure[];
  status: BulkJobRecord['status'];
  createdAt: Date;
  expiresAt: Date;
}

const COLUMNS = `id, "shopId", total, chunks, "completedChunks", applied, replayed, failed, failures, status, "createdAt", "expiresAt"`;

/** `ApiBulkJob` and `ApiBulkChunk` in Postgres (R-11); the chunk tasks travel on the outbox in the job's own transaction. */
@Injectable()
export class SequelizeBulkJobRepository extends BulkJobRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {
    super();
  }

  async create(input: {
    id: string;
    shopId: string;
    total: number;
    messages: BulkChunkMessageBody[];
    now: Date;
  }): Promise<void> {
    const { id, shopId, total, messages, now } = input;
    await this.runner.run(async (tx) => {
      await this.sequelize.query(
        `INSERT INTO "ApiBulkJob" (id, "shopId", total, chunks, status, "createdAt", "expiresAt")
         VALUES (:id, :shopId, :total, :chunks, 'processing', :now, :expiresAt)`,
        {
          transaction: tx,
          replacements: {
            id,
            shopId,
            total,
            chunks: chunkCount(total),
            now,
            expiresAt: new Date(now.getTime() + BULK_RETENTION_MS),
          },
        },
      );
      await this.sequelize.query(
        `INSERT INTO "ApiBulkChunk" ("jobId", "index", "shopId", state)
         SELECT :id, g, :shopId, 'pending' FROM generate_series(0, :last) g`,
        {
          transaction: tx,
          replacements: { id, shopId, last: messages.length - 1 },
        },
      );
      for (const body of messages)
        await this.outbox.appendTask(
          {
            queue: BULK_CHUNK_QUEUE,
            type: BULK_CHUNK_TASK,
            aggregateId: id,
            body,
          },
          tx,
        );
    });
  }

  async find(shopId: string, id: string): Promise<BulkJobRecord | null> {
    const [row] = await this.sequelize.query<JobRow>(
      `SELECT ${COLUMNS} FROM "ApiBulkJob" WHERE id = :id AND "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { id, shopId } },
    );
    return row ?? null;
  }

  async chunkState(
    jobId: string,
    index: number,
  ): Promise<'pending' | 'done' | 'failed' | null> {
    const [row] = await this.sequelize.query<{
      state: 'pending' | 'done' | 'failed';
    }>(
      `SELECT state FROM "ApiBulkChunk" WHERE "jobId" = :jobId AND "index" = :index`,
      { type: QueryTypes.SELECT, replacements: { jobId, index } },
    );
    return row?.state ?? null;
  }

  async completeChunk(input: {
    jobId: string;
    shopId: string;
    index: number;
    totals: {
      applied: number;
      replayed: number;
      failed: number;
      failures: BulkFailure[];
    };
    now: Date;
  }): Promise<'recorded' | 'duplicate'> {
    const { jobId, shopId, index, totals, now } = input;
    return this.runner.run(async (tx) => {
      const flipped = await this.sequelize.query(
        `UPDATE "ApiBulkChunk" SET state = 'done', result = CAST(:result AS jsonb), "completedAt" = :now
          WHERE "jobId" = :jobId AND "index" = :index AND "shopId" = :shopId AND state = 'pending'
          RETURNING "index"`,
        {
          type: QueryTypes.SELECT,
          transaction: tx,
          replacements: {
            jobId,
            index,
            shopId,
            now,
            result: JSON.stringify(totals),
          },
        },
      );
      if (flipped.length === 0) return 'duplicate' as const;
      const [job] = await this.sequelize.query<JobRow>(
        `UPDATE "ApiBulkJob"
            SET "completedChunks" = "completedChunks" + 1,
                applied = applied + :applied, replayed = replayed + :replayed, failed = failed + :failed,
                failures = jsonb_path_query_array(failures || CAST(:failures AS jsonb), CAST(:slice AS jsonpath))
          WHERE id = :jobId AND "shopId" = :shopId
          RETURNING ${COLUMNS}`,
        {
          type: QueryTypes.SELECT,
          transaction: tx,
          replacements: {
            jobId,
            shopId,
            applied: totals.applied,
            replayed: totals.replayed,
            failed: totals.failed,
            failures: JSON.stringify(totals.failures),
            slice: `$[0 to ${FAILURES_KEPT - 1}]`,
          },
        },
      );
      if (job) {
        await this.sequelize.query(
          `UPDATE "ApiBulkJob" SET status = :status WHERE id = :jobId`,
          {
            transaction: tx,
            replacements: { jobId, status: bulkStatus(job) },
          },
        );
      }
      return 'recorded' as const;
    });
  }

  async purgeExpired(now: Date, batch: number): Promise<number> {
    const rows = await this.sequelize.query<{ id: string }>(
      `WITH doomed AS (
         SELECT id FROM "ApiBulkJob" WHERE "expiresAt" <= :now ORDER BY "expiresAt" LIMIT :batch FOR UPDATE SKIP LOCKED
       ), chunks AS (
         DELETE FROM "ApiBulkChunk" WHERE "jobId" IN (SELECT id FROM doomed)
       )
       DELETE FROM "ApiBulkJob" WHERE id IN (SELECT id FROM doomed) RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { now, batch } },
    );
    return rows.length;
  }
}
