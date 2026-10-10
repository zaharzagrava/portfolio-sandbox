import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { nextFireAt } from './cron';
import { decodeCursor, encodeCursor } from './job-cursor';
import { JOB_STATUSES, JobStatus, sourceStatus } from './job-state';
import { CancelResult } from './job-types';
import { JobsService } from './jobs.service';

/** What an operator sees of a job. Never the payload (it may hold personal data). */
export interface JobDto {
  id: string;
  type: string;
  status: JobStatus;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  shopId: string | null;
  lastError: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface JobFilter {
  status?: JobStatus;
  type?: string;
  shopId?: string;
}

export interface JobPage {
  limit?: number;
  cursor?: string;
}

export interface JobTypeStats {
  type: string;
  counts: Record<JobStatus, number>;
  /** `runAt` of the oldest QUEUED job that is already due, if any. */
  oldestDueRunAt: Date | null;
  lagSeconds: number;
}

export type RetryResult =
  | { outcome: 'RETRIED' }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'CONFLICT'; status: JobStatus };

export interface ScheduleDto {
  name: string;
  cron: string;
  timezone: string;
  jobType: string;
  enabled: boolean;
  overlap: 'skip' | 'allow';
  maxAttempts: number | null;
  nextFireAt: Date;
  lastFiredAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Operator-facing view of the job system for S01's admin routes (DTOs only, never rows). Role checks are S01's job:
 * infrastructure does not import identity (X.5).
 */
@Injectable()
export class JobsAdminService {
  private readonly logger = new Logger(JobsAdminService.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly jobs: JobsService,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
  ) {}

  /** Newest first, keyset-paginated by `(createdAt, id)`; `nextCursor` is set when more rows follow. */
  async listJobs(
    filter: JobFilter = {},
    page: JobPage = {},
  ): Promise<{ items: JobDto[]; nextCursor?: string }> {
    if (filter.status !== undefined && !JOB_STATUSES.includes(filter.status))
      throw new RangeError(`unknown job status "${String(filter.status)}"`);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Math.trunc(page.limit ?? DEFAULT_LIMIT)),
    );
    const where: string[] = [];
    const replacements: Record<string, unknown> = { limit: limit + 1 };
    if (filter.status) {
      where.push('status = :status');
      replacements.status = filter.status;
    }
    if (filter.type) {
      where.push('type = :type');
      replacements.type = filter.type;
    }
    if (filter.shopId) {
      where.push('"shopId" = :shopId');
      replacements.shopId = filter.shopId;
    }
    if (page.cursor !== undefined) {
      const position = decodeCursor(page.cursor);
      where.push(
        `("createdAt", id) < (CAST(:cursorCreatedAt AS timestamptz), CAST(:cursorId AS uuid))`,
      );
      replacements.cursorCreatedAt = position.createdAt;
      replacements.cursorId = position.id;
    }

    const rows = await this.sequelize.query<JobDto & { createdAtText: string }>(
      `SELECT id, type, status, "runAt", attempts, "maxAttempts", "shopId", "lastError", "createdAt",
              "createdAt"::text AS "createdAtText", "finishedAt"
       FROM "Job" ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY "createdAt" DESC, id DESC LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements },
    );
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(({ createdAtText: _text, ...dto }) => dto),
      nextCursor:
        more && last
          ? encodeCursor({ createdAt: last.createdAtText, id: last.id })
          : undefined,
    };
  }

  /** Per job type: counts by status, the oldest due job and the lag in seconds. */
  async getStats(): Promise<JobTypeStats[]> {
    const now = this.clock.now();
    const counts = await this.sequelize.query<{
      type: string;
      status: JobStatus;
      n: number;
    }>(
      `SELECT type, status, count(*)::int AS n FROM "Job" GROUP BY type, status`,
      {
        type: QueryTypes.SELECT,
      },
    );
    const due = await this.sequelize.query<{ type: string; oldest: Date }>(
      `SELECT type, min("runAt") AS oldest FROM "Job"
       WHERE status = 'QUEUED' AND "runAt" <= :now GROUP BY type`,
      { type: QueryTypes.SELECT, replacements: { now } },
    );
    const byType = new Map<string, JobTypeStats>();
    const entry = (type: string) => {
      let e = byType.get(type);
      if (!e) {
        e = {
          type,
          counts: Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<
            JobStatus,
            number
          >,
          oldestDueRunAt: null,
          lagSeconds: 0,
        };
        byType.set(type, e);
      }
      return e;
    };
    for (const { type, status, n } of counts) entry(type).counts[status] = n;
    for (const { type, oldest } of due) {
      const e = entry(type);
      e.oldestDueRunAt = new Date(oldest);
      e.lagSeconds = Math.max(
        0,
        (now.getTime() - e.oldestDueRunAt.getTime()) / 1000,
      );
    }
    return [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
  }

  /** Moves a DEAD job back to QUEUED (attempts 0, due now). Only DEAD qualifies; concurrent calls: one wins. */
  async retryDead(jobId: string, actorId: string): Promise<RetryResult> {
    const retried = await this.sequelize.query<{ id: string }>(
      `UPDATE "Job" SET status = 'QUEUED', attempts = 0, "runAt" = :now, "finishedAt" = NULL,
         "lockedBy" = NULL, "lockedUntil" = NULL
       WHERE id = :id AND status = :from RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          id: jobId,
          now: this.clock.now(),
          from: sourceStatus('operatorRetry'),
        },
      },
    );
    if (retried.length > 0) {
      this.logger.log({
        message: 'dead job retried by an operator',
        jobId,
        previousStatus: 'DEAD',
        actorId,
      });
      return { outcome: 'RETRIED' };
    }
    const [found] = await this.sequelize.query<{ status: JobStatus }>(
      `SELECT status FROM "Job" WHERE id = :id LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { id: jobId } },
    );
    return found
      ? { outcome: 'CONFLICT', status: found.status }
      : { outcome: 'NOT_FOUND' };
  }

  cancel(jobId: string): Promise<CancelResult> {
    return this.jobs.cancel(jobId);
  }

  async listSchedules(): Promise<ScheduleDto[]> {
    return this.sequelize.query<ScheduleDto>(
      `SELECT name, cron, timezone, "jobType", enabled, overlap, "maxAttempts", "nextFireAt", "lastFiredAt",
              "consecutiveFailures", "lastError"
       FROM "JobSchedule" ORDER BY name`,
      { type: QueryTypes.SELECT },
    );
  }

  /** Enabling computes the next fire from now (no catch-up of what was missed while disabled). */
  async setScheduleEnabled(name: string, enabled: boolean): Promise<boolean> {
    const [schedule] = await this.sequelize.query<{
      cron: string;
      timezone: string;
    }>(`SELECT cron, timezone FROM "JobSchedule" WHERE name = :name`, {
      type: QueryTypes.SELECT,
      replacements: { name },
    });
    if (!schedule) return false;
    const now = this.clock.now();
    await this.sequelize.query(
      `UPDATE "JobSchedule" SET enabled = :enabled, "updatedAt" = :now,
         "nextFireAt" = CASE WHEN :enabled AND NOT enabled THEN CAST(:next AS timestamptz) ELSE "nextFireAt" END,
         "consecutiveFailures" = CASE WHEN :enabled THEN 0 ELSE "consecutiveFailures" END,
         "lastError" = CASE WHEN :enabled THEN NULL ELSE "lastError" END
       WHERE name = :name`,
      {
        replacements: {
          name,
          enabled,
          now,
          next: nextFireAt(schedule.cron, schedule.timezone, now),
        },
      },
    );
    return true;
  }
}
