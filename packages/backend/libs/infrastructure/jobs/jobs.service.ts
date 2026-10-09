import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { EnqueueOptions, JobPayloads, JobType } from './job-types';
import { isValidCron, nextFireAt } from './cron';

/**
 * Enqueue API used by every domain. Runs inside the caller's transaction when
 * there is one (Sequelize CLS, F-01): "create auction + schedule its close" is
 * atomic - no job for a rolled-back auction, no auction without its close job.
 * That's why scheduled work needs no outbox.
 */
@Injectable()
export class JobsService {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async enqueue<T extends JobType>(
    type: T,
    payload: JobPayloads[T],
    options: EnqueueOptions = {},
  ): Promise<{ id: string; created: boolean }> {
    const {
      runAt = new Date(),
      idempotencyKey,
      shopId,
      maxAttempts = 8,
    } = options;

    // One statement: dedupe via JobKey (global PK) and insert the job only if the key was new.
    const rows = await this.sequelize.query<{ id: string; created: boolean }>(
      `
      WITH new_id AS (SELECT uuidv7() AS id),
      key AS (
        INSERT INTO "JobKey" ("idempotencyKey", "jobId")
        SELECT :idempotencyKey, id FROM new_id WHERE :idempotencyKey IS NOT NULL
        ON CONFLICT ("idempotencyKey") DO NOTHING
        RETURNING "jobId"
      ),
      inserted AS (
        INSERT INTO "Job" ("id", "type", "payload", "runAt", "shopId", "idempotencyKey", "maxAttempts")
        SELECT id, :type, CAST(:payload AS JSONB), :runAt, :shopId, :idempotencyKey, :maxAttempts FROM new_id
        WHERE :idempotencyKey IS NULL OR EXISTS (SELECT 1 FROM key)
        RETURNING "id"
      )
      SELECT id, TRUE AS created FROM inserted
      UNION ALL
      SELECT "jobId" AS id, FALSE AS created FROM "JobKey"
      WHERE :idempotencyKey IS NOT NULL AND "idempotencyKey" = :idempotencyKey AND NOT EXISTS (SELECT 1 FROM inserted)
      `,
      {
        type: QueryTypes.SELECT,
        replacements: {
          type,
          payload: JSON.stringify(payload),
          runAt,
          shopId: shopId ?? null,
          idempotencyKey: idempotencyKey ?? null,
          maxAttempts,
        },
      },
    );
    if (rows[0]) return rows[0];

    // Lost a race on the same key with a transaction that committed after our
    // statement snapshot was taken: the key exists but this statement couldn't
    // see it. A new statement gets a fresh snapshot (READ COMMITTED).
    const [existing] = await this.sequelize.query<{ jobId: string }>(
      `SELECT "jobId" FROM "JobKey" WHERE "idempotencyKey" = :idempotencyKey`,
      { type: QueryTypes.SELECT, replacements: { idempotencyKey } },
    );
    return { id: existing.jobId, created: false };
  }

  async cancel(jobId: string): Promise<boolean> {
    const [, meta] = await this.sequelize.query(
      `UPDATE "Job" SET status = 'CANCELLED', "finishedAt" = now() WHERE id = :jobId AND status = 'QUEUED'`,
      {
        replacements: { jobId },
      },
    );
    return ((meta as { rowCount?: number })?.rowCount ?? 0) > 0;
  }

  /** Creates or updates a recurring schedule; the CronMaterializer turns it into jobs. */
  async upsertSchedule<T extends JobType>(schedule: {
    name: string;
    cron: string;
    timezone?: string;
    jobType: T;
    payload: JobPayloads[T];
    enabled?: boolean;
  }): Promise<void> {
    const timezone = schedule.timezone ?? 'UTC';
    if (!isValidCron(schedule.cron, timezone))
      throw new Error(`Invalid cron "${schedule.cron}" (${timezone})`);

    await this.sequelize.query(
      `INSERT INTO "JobSchedule" ("name", "cron", "timezone", "jobType", "payload", "enabled", "nextFireAt")
       VALUES (:name, :cron, :timezone, :jobType, CAST(:payload AS JSONB), :enabled, :nextFireAt)
       ON CONFLICT ("name") DO UPDATE SET
         "cron" = EXCLUDED."cron", "timezone" = EXCLUDED."timezone", "jobType" = EXCLUDED."jobType",
         "payload" = EXCLUDED."payload", "enabled" = EXCLUDED."enabled",
         "nextFireAt" = CASE WHEN "JobSchedule"."cron" = EXCLUDED."cron" AND "JobSchedule"."timezone" = EXCLUDED."timezone"
                             THEN "JobSchedule"."nextFireAt" ELSE EXCLUDED."nextFireAt" END,
         "updatedAt" = now()`,
      {
        replacements: {
          name: schedule.name,
          cron: schedule.cron,
          timezone,
          jobType: schedule.jobType,
          payload: JSON.stringify(schedule.payload),
          enabled: schedule.enabled ?? true,
          nextFireAt: nextFireAt(schedule.cron, timezone, new Date()),
        },
      },
    );
  }
}
