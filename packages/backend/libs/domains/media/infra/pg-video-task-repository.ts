import { readyTasks } from '../domain/dag';
import type { TaskStatus } from '../domain/dag';
import type { SqlRunner } from '../domain/ports';
import type {
  ClaimOutcome,
  ProgressRecord,
  TaskRecord,
  TaskRepository,
} from '../domain/video-ports';
import { toVideoRecord } from './pg-video-repository';

const TASK_COLUMNS = `"videoId", "name", "dependsOn", "status", "attempts", "claimedAttempt", "leaseExpiresAt", "lastSentAt", "output", "internalError", "updatedAt"`;
const VIDEO_COLUMNS = `"id", "shopId", "uploaderId", "title", "visibility", "status", "failureCode", "internalError", "retryCount", "sourceKey", "uploadId", "sizeBytes", "contentType", "partSize", "sessionExpiresAt", "shareToken", "productId", "durationSec", "width", "height", "outputs", "objectsPurgedAt", "edgePurgedAt", "readyAt", "version", "createdAt", "updatedAt"`;

const date = (value: unknown): Date | null =>
  value ? new Date(value as string) : null;

const toTask = (row: Record<string, unknown>): TaskRecord => ({
  ...(row as unknown as TaskRecord),
  leaseExpiresAt: date(row.leaseExpiresAt),
  lastSentAt: date(row.lastSentAt),
  updatedAt: new Date(row.updatedAt as string),
});

/**
 * Every statement of `VideoTask` (S30 R-6–R-9). A task changes only through a conditional update that names its source
 * status and, for a running task, the attempt that claimed it (fencing, AS-26). The fan-in (`dispatchReady`) holds the
 * video row lock, so two siblings finishing together queue `package` once (AS-22). No statement here waits for the
 * encoder: a running task holds no connection.
 */
export class PgVideoTaskRepository implements TaskRepository {
  constructor(private readonly sql: SqlRunner) {}

  async list(videoId: string) {
    const rows = await this.sql<Record<string, unknown>>(
      `SELECT ${TASK_COLUMNS} FROM "VideoTask" WHERE "videoId" = $1 ORDER BY "createdAt", "name"`,
      [videoId],
    );
    return rows.map(toTask);
  }

  private static summarize(
    rows: { name: string; status: TaskStatus }[],
  ): ProgressRecord {
    const done = rows.filter(
      (r) => r.status === 'DONE' || r.status === 'SKIPPED',
    ).length;
    const active =
      rows.find((r) => r.status === 'RUNNING') ??
      rows.find((r) => r.status === 'QUEUED') ??
      rows.find((r) => r.status === 'PENDING');
    return {
      stage: active?.name ?? (rows.length ? 'finished' : 'probe'),
      tasksDone: done,
      // before `probe` finishes the graph is just that one task
      tasksTotal: Math.max(1, rows.length),
    };
  }

  async progress(videoId: string): Promise<ProgressRecord> {
    const rows = await this.sql<{ name: string; status: TaskStatus }>(
      `SELECT "name", "status" FROM "VideoTask" WHERE "videoId" = $1`,
      [videoId],
    );
    return PgVideoTaskRepository.summarize(rows);
  }

  async progressMany(videoIds: string[]) {
    const out = new Map<string, ProgressRecord>();
    if (videoIds.length === 0) return out;
    const rows = await this.sql<{
      videoId: string;
      name: string;
      status: TaskStatus;
    }>(
      `SELECT "videoId", "name", "status" FROM "VideoTask" WHERE "videoId" = ANY($1::uuid[])`,
      [videoIds],
    );
    for (const id of videoIds)
      out.set(
        id,
        PgVideoTaskRepository.summarize(rows.filter((r) => r.videoId === id)),
      );
    return out;
  }

  async insertGraph(
    videoId: string,
    nodes: { name: string; deps: string[] }[],
    now: Date,
  ) {
    if (nodes.length === 0) return;
    await this.sql(
      `INSERT INTO "VideoTask" ("videoId", "name", "dependsOn", "status", "createdAt", "updatedAt")
       SELECT $1, n.name, n.deps::text[], 'PENDING', $4, $4
         FROM unnest($2::text[], $3::text[]) AS n(name, deps)
       ON CONFLICT ("videoId", "name") DO NOTHING`,
      [
        videoId,
        nodes.map((n) => n.name),
        // text[] in text[]: '{a,b}' literals (task names never contain a comma, quote or brace)
        nodes.map((n) => `{${n.deps.join(',')}}`),
        now,
      ],
    );
  }

  async dispatchReady(videoId: string, now: Date) {
    const [video] = await this.sql<{ status: string }>(
      `SELECT "status" FROM "Video" WHERE "id" = $1 FOR UPDATE`,
      [videoId],
    );
    if (video?.status !== 'PROCESSING') return [];
    const nodes = await this.sql<{
      name: string;
      dependsOn: string[];
      status: TaskStatus;
    }>(
      `SELECT "name", "dependsOn", "status" FROM "VideoTask" WHERE "videoId" = $1`,
      [videoId],
    );
    const ready = readyTasks(
      nodes.map((n) => ({ name: n.name, deps: n.dependsOn, status: n.status })),
    );
    if (ready.length === 0) return [];
    const rows = await this.sql<{ name: string }>(
      `UPDATE "VideoTask" SET "status" = 'QUEUED', "lastSentAt" = $3, "updatedAt" = $3
        WHERE "videoId" = $1 AND "name" = ANY($2::text[]) AND "status" = 'PENDING' RETURNING "name"`,
      [videoId, ready, now],
    );
    return rows.map((r) => r.name);
  }

  async claim(input: {
    videoId: string;
    name: string;
    now: Date;
    leaseUntil: Date;
    maxAttempts: number;
  }): Promise<ClaimOutcome> {
    const rows = await this.sql<Record<string, unknown>>(
      `WITH old AS (
         SELECT t."videoId", t."name" FROM "VideoTask" t JOIN "Video" v ON v."id" = t."videoId"
          WHERE t."videoId" = $1 AND t."name" = $2 AND v."status" = 'PROCESSING' AND t."attempts" < $5
            AND (t."status" = 'QUEUED' OR (t."status" = 'RUNNING' AND t."leaseExpiresAt" <= $3))
          FOR UPDATE OF t
       )
       UPDATE "VideoTask" t SET "status" = 'RUNNING', "attempts" = t."attempts" + 1, "claimedAttempt" = t."attempts" + 1,
              "leaseExpiresAt" = $4, "updatedAt" = $3
         FROM old WHERE t."videoId" = old."videoId" AND t."name" = old."name"
       RETURNING ${TASK_COLUMNS.split(', ')
         .map((c) => `t.${c}`)
         .join(', ')}`,
      [
        input.videoId,
        input.name,
        input.now,
        input.leaseUntil,
        input.maxAttempts,
      ],
    );
    if (rows.length > 0) {
      const [video] = await this.sql<Record<string, unknown>>(
        `SELECT ${VIDEO_COLUMNS} FROM "Video" WHERE "id" = $1`,
        [input.videoId],
      );
      return {
        outcome: 'claimed',
        task: toTask(rows[0]),
        video: toVideoRecord(video),
      };
    }
    const [current] = await this.sql<{
      status: TaskStatus;
      attempts: number;
      leaseExpiresAt: Date | null;
      videoStatus: string;
    }>(
      `SELECT t."status", t."attempts", t."leaseExpiresAt", v."status" AS "videoStatus"
         FROM "VideoTask" t JOIN "Video" v ON v."id" = t."videoId"
        WHERE t."videoId" = $1 AND t."name" = $2`,
      [input.videoId, input.name],
    );
    if (!current || current.videoStatus !== 'PROCESSING')
      return { outcome: 'stale' };
    if (
      current.status === 'RUNNING' &&
      current.leaseExpiresAt &&
      new Date(current.leaseExpiresAt) > input.now
    )
      return { outcome: 'busy' };
    if (
      (current.status === 'QUEUED' || current.status === 'RUNNING') &&
      current.attempts >= input.maxAttempts
    ) {
      const [row] = await this.sql<Record<string, unknown>>(
        `SELECT ${TASK_COLUMNS} FROM "VideoTask" WHERE "videoId" = $1 AND "name" = $2`,
        [input.videoId, input.name],
      );
      return { outcome: 'exhausted', task: toTask(row) };
    }
    return { outcome: 'stale' };
  }

  async heartbeat(input: {
    videoId: string;
    name: string;
    attempt: number;
    now: Date;
    leaseUntil: Date;
  }) {
    const rows = await this.sql(
      `UPDATE "VideoTask" SET "leaseExpiresAt" = $5, "updatedAt" = $4
        WHERE "videoId" = $1 AND "name" = $2 AND "claimedAttempt" = $3 AND "status" = 'RUNNING' RETURNING 1`,
      [input.videoId, input.name, input.attempt, input.now, input.leaseUntil],
    );
    return rows.length === 1;
  }

  async complete(input: {
    videoId: string;
    name: string;
    attempt: number;
    output: Record<string, unknown>;
    now: Date;
  }) {
    const rows = await this.sql(
      `UPDATE "VideoTask" SET "status" = 'DONE', "output" = $5::jsonb, "leaseExpiresAt" = NULL, "updatedAt" = $4
        WHERE "videoId" = $1 AND "name" = $2 AND "claimedAttempt" = $3 AND "status" = 'RUNNING' RETURNING 1`,
      [
        input.videoId,
        input.name,
        input.attempt,
        input.now,
        JSON.stringify(input.output),
      ],
    );
    return rows.length === 1;
  }

  async requeue(input: {
    videoId: string;
    name: string;
    attempt: number;
    internalError: string;
    now: Date;
    keepAttempt?: boolean;
  }) {
    const rows = await this.sql(
      `UPDATE "VideoTask" SET "status" = 'QUEUED', "leaseExpiresAt" = NULL, "internalError" = $5, "lastSentAt" = $4, "updatedAt" = $4,
              "attempts" = "attempts" - $6
        WHERE "videoId" = $1 AND "name" = $2 AND "claimedAttempt" = $3 AND "status" = 'RUNNING' RETURNING 1`,
      [
        input.videoId,
        input.name,
        input.attempt,
        input.now,
        input.internalError.slice(0, 500),
        input.keepAttempt ? 1 : 0,
      ],
    );
    return rows.length === 1;
  }

  private async finish(
    status: 'SKIPPED' | 'FAILED',
    input: {
      videoId: string;
      name: string;
      attempt: number;
      internalError: string;
      now: Date;
    },
  ) {
    const rows = await this.sql(
      `UPDATE "VideoTask" SET "status" = $5, "leaseExpiresAt" = NULL, "internalError" = $6, "updatedAt" = $4
        WHERE "videoId" = $1 AND "name" = $2 AND "claimedAttempt" = $3 AND "status" = 'RUNNING' RETURNING 1`,
      [
        input.videoId,
        input.name,
        input.attempt,
        input.now,
        status,
        input.internalError.slice(0, 500),
      ],
    );
    return rows.length === 1;
  }

  skip(input: Parameters<TaskRepository['skip']>[0]) {
    return this.finish('SKIPPED', input);
  }

  failTask(input: Parameters<TaskRepository['failTask']>[0]) {
    return this.finish('FAILED', input);
  }

  async markSent(videoId: string, names: string[], now: Date) {
    if (names.length === 0) return;
    await this.sql(
      `UPDATE "VideoTask" SET "lastSentAt" = $3 WHERE "videoId" = $1 AND "name" = ANY($2::text[])`,
      [videoId, names, now],
    );
  }

  async claimResend(input: {
    videoId: string;
    name: string;
    now: Date;
    sentBefore: Date;
  }) {
    const rows = await this.sql(
      `UPDATE "VideoTask" SET "lastSentAt" = $3
        WHERE "videoId" = $1 AND "name" = $2 AND "status" = 'QUEUED' AND ("lastSentAt" IS NULL OR "lastSentAt" <= $4)
        RETURNING 1`,
      [input.videoId, input.name, input.now, input.sentBefore],
    );
    return rows.length === 1;
  }

  // ---- sweep

  listLeaseExpired(now: Date, limit: number) {
    return this.sql<{ videoId: string; name: string }>(
      `SELECT t."videoId", t."name" FROM "VideoTask" t JOIN "Video" v ON v."id" = t."videoId"
        WHERE t."status" = 'RUNNING' AND t."leaseExpiresAt" <= $1 AND v."status" = 'PROCESSING'
        ORDER BY t."leaseExpiresAt" LIMIT $2`,
      [now, limit],
    );
  }

  listQueuedStale(input: { before: Date; sentBefore: Date; limit: number }) {
    return this.sql<{ videoId: string; name: string }>(
      `SELECT t."videoId", t."name" FROM "VideoTask" t JOIN "Video" v ON v."id" = t."videoId"
        WHERE t."status" = 'QUEUED' AND t."updatedAt" <= $1 AND (t."lastSentAt" IS NULL OR t."lastSentAt" <= $2)
          AND v."status" = 'PROCESSING'
        ORDER BY t."updatedAt" LIMIT $3`,
      [input.before, input.sentBefore, input.limit],
    );
  }

  async releaseExpired(videoId: string, name: string, now: Date) {
    const rows = await this.sql(
      `UPDATE "VideoTask" SET "status" = 'QUEUED', "leaseExpiresAt" = NULL, "lastSentAt" = $3, "updatedAt" = $3
        WHERE "videoId" = $1 AND "name" = $2 AND "status" = 'RUNNING' AND "leaseExpiresAt" <= $3 RETURNING 1`,
      [videoId, name, now],
    );
    return rows.length === 1;
  }

  async listIdleProcessing(limit: number) {
    const rows = await this.sql<{ id: string }>(
      `SELECT v."id" FROM "Video" v
        WHERE v."status" = 'PROCESSING'
          AND EXISTS (SELECT 1 FROM "VideoTask" t WHERE t."videoId" = v."id" AND t."status" = 'PENDING')
          AND NOT EXISTS (SELECT 1 FROM "VideoTask" t WHERE t."videoId" = v."id" AND t."status" IN ('QUEUED', 'RUNNING'))
        ORDER BY v."updatedAt" LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.id);
  }
}
