import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { RequestContext } from '@app/infrastructure/context';
import {
  CancelResult,
  EnqueueOptions,
  JobPayloads,
  JobStatus,
  JobType,
} from './job-types';
import { nextFireAt } from './cron';
import { resolveMaxAttempts, validateEnqueueOptions } from './enqueue-options';
import {
  IdempotencyKeyConflictError,
  InvalidScheduleError,
} from './job-errors';
import { sourceStatus } from './job-state';
import { getJobTypeDeclaration, parseJobPayload } from './job-type-registry';
import { validateScheduleInput } from './schedule-validation';
import './jobs-builtin-types';

interface EnqueueRow {
  id: string;
  created: boolean;
  existingType: string | null;
}

/**
 * Enqueue API used by every domain. Runs inside the caller's transaction when
 * there is one (Sequelize CLS, F-01): "create auction + schedule its close" is
 * atomic - no job for a rolled-back auction, no auction without its close job.
 * That's why scheduled work needs no outbox.
 */
@Injectable()
export class JobsService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
    @Optional() private readonly requestContext?: RequestContext,
  ) {}

  async enqueue<T extends JobType>(
    type: T,
    payload: JobPayloads[T],
    options: EnqueueOptions = {},
  ): Promise<{ id: string; created: boolean }> {
    const now = this.clock.now();
    const declaration = getJobTypeDeclaration(type);
    const parsed = parseJobPayload(type, payload);
    validateEnqueueOptions(options, parsed, now);

    const origin = this.requestContext?.snapshot() ?? {};
    const replacements = {
      type,
      payload: JSON.stringify(parsed),
      runAt: options.runAt ?? now,
      shopId: options.shopId ?? null,
      idempotencyKey: options.idempotencyKey ?? null,
      maxAttempts: resolveMaxAttempts({
        option: options.maxAttempts,
        typeDefault: declaration?.maxAttempts,
      }),
      requestId: origin.requestId ?? null,
      traceparent: origin.traceparent ?? null,
    };

    // The statement can see no row when it lost a race on the key with a transaction that committed after its snapshot
    // (or a purge removed the key right after): look the key up with a fresh snapshot, and if it is gone insert again once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await this.insertOnce(replacements);
      if (row) return this.checked(row, type, options.idempotencyKey);
      if (options.idempotencyKey === undefined) break;
      const existing = await this.findKey(options.idempotencyKey);
      if (existing) return this.checked(existing, type, options.idempotencyKey);
    }
    throw new Error('enqueue: the job could not be created or found');
  }

  private checked(row: EnqueueRow, type: string, key?: string) {
    if (!row.created && key !== undefined && row.existingType !== type)
      throw new IdempotencyKeyConflictError(key, row.existingType ?? 'unknown');
    return { id: row.id, created: row.created };
  }

  private async insertOnce(
    r: Record<string, unknown>,
  ): Promise<EnqueueRow | undefined> {
    // One statement: dedupe via JobKey (global PK) and insert the job only if the key was new.
    const rows = await this.sequelize.query<EnqueueRow>(
      `
      WITH new_id AS (SELECT uuidv7() AS id),
      key AS (
        INSERT INTO "JobKey" ("idempotencyKey", "jobId", "type")
        SELECT :idempotencyKey, id, :type FROM new_id WHERE :idempotencyKey IS NOT NULL
        ON CONFLICT ("idempotencyKey") DO NOTHING
        RETURNING "jobId"
      ),
      inserted AS (
        INSERT INTO "Job" ("id", "type", "payload", "runAt", "shopId", "idempotencyKey", "maxAttempts",
                           "enqueuedByRequestId", "traceparent")
        SELECT id, :type, CAST(:payload AS JSONB), :runAt, :shopId, :idempotencyKey, :maxAttempts,
               :requestId, :traceparent FROM new_id
        WHERE :idempotencyKey IS NULL OR EXISTS (SELECT 1 FROM key)
        RETURNING "id"
      )
      SELECT id, TRUE AS created, NULL::text AS "existingType" FROM inserted
      UNION ALL
      SELECT k."jobId" AS id, FALSE AS created,
             -- keys written before the type column existed fall back to the job row
             coalesce(k."type", (SELECT j."type" FROM "Job" j WHERE j."id" = k."jobId" LIMIT 1)) AS "existingType"
      FROM "JobKey" k
      WHERE :idempotencyKey IS NOT NULL AND k."idempotencyKey" = :idempotencyKey AND NOT EXISTS (SELECT 1 FROM inserted)
      `,
      { type: QueryTypes.SELECT, replacements: r },
    );
    return rows[0];
  }

  private async findKey(key: string): Promise<EnqueueRow | undefined> {
    const [existing] = await this.sequelize.query<EnqueueRow>(
      `SELECT k."jobId" AS id, FALSE AS created,
              coalesce(k."type", (SELECT j."type" FROM "Job" j WHERE j."id" = k."jobId" LIMIT 1)) AS "existingType"
       FROM "JobKey" k WHERE k."idempotencyKey" = :key`,
      { type: QueryTypes.SELECT, replacements: { key } },
    );
    return existing;
  }

  /** Cancels a QUEUED job. Another shop's job (when `shopId` is given) is NOT_FOUND, never revealed. */
  async cancel(
    jobId: string,
    scope: { shopId?: string } = {},
  ): Promise<CancelResult> {
    return this.cancelWhere(`j."id" = :ref`, jobId, scope);
  }

  async cancelByKey(
    key: string,
    scope: { shopId?: string } = {},
  ): Promise<CancelResult> {
    return this.cancelWhere(
      `j."id" = (SELECT "jobId" FROM "JobKey" WHERE "idempotencyKey" = :ref)`,
      key,
      scope,
    );
  }

  private async cancelWhere(
    predicate: string,
    ref: string,
    { shopId }: { shopId?: string },
  ): Promise<CancelResult> {
    const replacements = {
      ref,
      shopId: shopId ?? null,
      now: this.clock.now(),
      from: sourceStatus('cancel'),
    };
    const shopFilter = `AND (:shopId IS NULL OR j."shopId" = :shopId)`;
    const cancelled = await this.sequelize.query<{ id: string }>(
      `UPDATE "Job" j SET status = 'CANCELLED', "finishedAt" = :now
       WHERE ${predicate} AND j.status = :from ${shopFilter}
       RETURNING j.id`,
      { type: QueryTypes.SELECT, replacements },
    );
    if (cancelled.length > 0) return { outcome: 'CANCELLED' };

    const [found] = await this.sequelize.query<{ status: JobStatus }>(
      `SELECT j.status FROM "Job" j WHERE ${predicate} ${shopFilter} LIMIT 1`,
      { type: QueryTypes.SELECT, replacements },
    );
    return found
      ? { outcome: 'CONFLICT', status: found.status }
      : { outcome: 'NOT_FOUND' };
  }

  /**
   * Creates or updates a recurring schedule by name; the materialiser turns it into jobs. Idempotent and safe to call
   * from every replica at boot. `enabled` left out keeps the stored flag (an operator's disable survives a deploy).
   */
  async upsertSchedule<T extends JobType>(schedule: {
    name: string;
    cron: string;
    timezone?: string;
    jobType: T;
    payload: JobPayloads[T];
    enabled?: boolean;
    overlap?: 'skip' | 'allow';
    maxAttempts?: number;
  }): Promise<void> {
    const timezone = schedule.timezone ?? 'UTC';
    validateScheduleInput({ ...schedule, timezone });
    if (!getJobTypeDeclaration(schedule.jobType))
      throw new InvalidScheduleError(
        'jobType',
        `unknown job type "${schedule.jobType}"`,
      );
    let payload: unknown;
    try {
      payload = parseJobPayload(schedule.jobType, schedule.payload);
    } catch (error) {
      throw new InvalidScheduleError('payload', (error as Error).message);
    }

    await this.sequelize.query(
      `INSERT INTO "JobSchedule" ("name", "cron", "timezone", "jobType", "payload", "enabled", "overlap", "maxAttempts", "nextFireAt")
       VALUES (:name, :cron, :timezone, :jobType, CAST(:payload AS JSONB), coalesce(:enabled, TRUE), :overlap, :maxAttempts, :nextFireAt)
       ON CONFLICT ("name") DO UPDATE SET
         "cron" = EXCLUDED."cron", "timezone" = EXCLUDED."timezone", "jobType" = EXCLUDED."jobType",
         "payload" = EXCLUDED."payload", "overlap" = EXCLUDED."overlap", "maxAttempts" = EXCLUDED."maxAttempts",
         "enabled" = coalesce(:enabled, "JobSchedule"."enabled"),
         "nextFireAt" = CASE WHEN "JobSchedule"."cron" = EXCLUDED."cron" AND "JobSchedule"."timezone" = EXCLUDED."timezone"
                                  AND ("JobSchedule"."enabled" OR NOT coalesce(:enabled, "JobSchedule"."enabled"))
                             THEN "JobSchedule"."nextFireAt" ELSE EXCLUDED."nextFireAt" END,
         "consecutiveFailures" = CASE WHEN NOT "JobSchedule"."enabled" AND coalesce(:enabled, "JobSchedule"."enabled")
                                      THEN 0 ELSE "JobSchedule"."consecutiveFailures" END,
         "updatedAt" = :now
       WHERE ("JobSchedule"."cron", "JobSchedule"."timezone", "JobSchedule"."jobType", "JobSchedule"."payload",
              "JobSchedule"."overlap", "JobSchedule"."maxAttempts", "JobSchedule"."enabled")
             IS DISTINCT FROM
             (EXCLUDED."cron", EXCLUDED."timezone", EXCLUDED."jobType", EXCLUDED."payload",
              EXCLUDED."overlap", EXCLUDED."maxAttempts", coalesce(:enabled, "JobSchedule"."enabled"))`,
      {
        replacements: {
          name: schedule.name,
          cron: schedule.cron,
          timezone,
          jobType: schedule.jobType,
          payload: JSON.stringify(payload),
          enabled: schedule.enabled ?? null,
          overlap: schedule.overlap ?? 'skip',
          maxAttempts: schedule.maxAttempts ?? null,
          nextFireAt: nextFireAt(schedule.cron, timezone, this.clock.now()),
          now: this.clock.now(),
        },
      },
    );
  }

  /** Deletes a schedule; jobs it already created stay. Returns whether it existed. */
  async removeSchedule(name: string): Promise<boolean> {
    const rows = await this.sequelize.query<{ name: string }>(
      `DELETE FROM "JobSchedule" WHERE "name" = :name RETURNING "name"`,
      { type: QueryTypes.SELECT, replacements: { name } },
    );
    return rows.length > 0;
  }
}
