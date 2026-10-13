import type { VideoFailureCode } from '@marketplace-sandbox/contracts';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { appendWithExecutor } from '@app/infrastructure/outbox/append-with-executor';
import { VideoDeleted, VideoFailed, VideoReady } from '../domain/video-events';
import { isRetryable } from '../domain/video-errors';
import type { SqlRunner } from '../domain/ports';
import type {
  InsertUploadingResult,
  ListFilter,
  PatchResult,
  RetryResult,
  VideoActor,
  VideoOutputs,
  VideoRecord,
  VideoRepository,
} from '../domain/video-ports';
import {
  MAX_PENDING_UPLOADS,
  MAX_VIDEOS_PER_PRODUCT,
} from '../domain/video-limits';
import { MAX_VIDEO_RETRIES } from '../domain/task-limits';
import type { VideoStatus } from '../domain/video-status';
import { readyTasks } from '../domain/dag';
import type { TaskStatus } from '../domain/dag';

const COLUMNS = `"id", "shopId", "uploaderId", "title", "visibility", "status", "failureCode", "internalError", "retryCount", "sourceKey", "uploadId", "sizeBytes", "contentType", "partSize", "sessionExpiresAt", "shareToken", "productId", "durationSec", "width", "height", "outputs", "objectsPurgedAt", "edgePurgedAt", "readyAt", "version", "createdAt", "updatedAt"`;
const prefixed = (alias: string) =>
  COLUMNS.split(', ')
    .map((c) => `${alias}.${c}`)
    .join(', ');

const date = (value: unknown): Date | null =>
  value ? new Date(value as string) : null;

export const toVideoRecord = (row: Record<string, unknown>): VideoRecord => ({
  ...(row as unknown as VideoRecord),
  sizeBytes: Number(row.sizeBytes),
  durationSec: row.durationSec === null ? null : Number(row.durationSec),
  sessionExpiresAt: new Date(row.sessionExpiresAt as string),
  objectsPurgedAt: date(row.objectsPurgedAt),
  edgePurgedAt: date(row.edgePurgedAt),
  readyAt: date(row.readyAt),
  createdAt: new Date(row.createdAt as string),
  updatedAt: new Date(row.updatedAt as string),
});

const actorColumns = (actor: VideoActor): [string, string | null] => [
  actor.type,
  actor.type === 'user' ? actor.id : null,
];

const OPEN_TASKS = `'PENDING', 'QUEUED', 'RUNNING'`;

/**
 * Every statement of `Video` and its history (S30 D-6): one conditional `UPDATE … WHERE id AND status = ANY(from)` per
 * transition, asserting one row, plus its `VideoStatusHistory` row and its outbox event in the same transaction
 * (III.7, IX.6). Every seller lookup carries the shop (III.4). No join on another domain's table (IX.4). The caller
 * supplies the `SqlRunner`; inside `TransactionRunner.run` it joins the active transaction.
 */
export class PgVideoRepository implements VideoRepository {
  constructor(private readonly sql: SqlRunner) {}

  private append(event: EventEnvelope, now: Date): Promise<void> {
    return appendWithExecutor(
      { query: (text, params) => this.sql(text, params) },
      event,
      { now },
    );
  }

  private history(
    videoId: string,
    from: string | null,
    to: VideoStatus,
    actor: VideoActor,
    now: Date,
    failureCode: VideoFailureCode | null = null,
  ): Promise<unknown[]> {
    const [actorType, actorId] = actorColumns(actor);
    return this.sql(
      `INSERT INTO "VideoStatusHistory" ("videoId", "fromStatus", "toStatus", "actorType", "actorId", "failureCode", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [videoId, from, to, actorType, actorId, failureCode, now],
    );
  }

  private cancelOpenTasks(videoIds: string[], now: Date): Promise<unknown[]> {
    return this.sql(
      `UPDATE "VideoTask" SET "status" = 'CANCELLED', "leaseExpiresAt" = NULL, "updatedAt" = $2
        WHERE "videoId" = ANY($1::uuid[]) AND "status" IN (${OPEN_TASKS})`,
      [videoIds, now],
    );
  }

  /** The common transition: lock the row in one of `from`, update it (+1 version), write the history row. */
  private async move(input: {
    id: string;
    shopId?: string | null;
    from: VideoStatus[];
    to: VideoStatus;
    assignments?: string;
    params?: unknown[];
    actor: VideoActor;
    now: Date;
    failureCode?: VideoFailureCode | null;
    extraWhere?: string;
  }): Promise<{ video: VideoRecord; previous: VideoStatus } | null> {
    const shop = input.shopId
      ? `AND "shopId" = $${5 + (input.params?.length ?? 0)}`
      : '';
    const rows = await this.sql<Record<string, unknown>>(
      `WITH old AS (
         SELECT "id", "status" FROM "Video" WHERE "id" = $1 AND "status" = ANY($2::text[]) ${shop} ${input.extraWhere ?? ''} FOR UPDATE
       ), upd AS (
         UPDATE "Video" v SET "status" = $3, "version" = v."version" + 1, "updatedAt" = $4${input.assignments ? `, ${input.assignments}` : ''}
           FROM old WHERE v."id" = old."id"
         RETURNING ${prefixed('v')}, old."status" AS "prevStatus"
       ) SELECT * FROM upd`,
      [
        input.id,
        input.from,
        input.to,
        input.now,
        ...(input.params ?? []),
        ...(input.shopId ? [input.shopId] : []),
      ],
    );
    if (rows.length === 0) return null;
    const { prevStatus, ...row } = rows[0];
    await this.history(
      input.id,
      prevStatus as string,
      input.to,
      input.actor,
      input.now,
      input.failureCode ?? null,
    );
    return {
      video: toVideoRecord(row),
      previous: prevStatus as VideoStatus,
    };
  }

  // ---- upload

  async insertUploading(input: {
    id: string;
    shopId: string;
    uploaderId: string;
    title: string;
    visibility: VideoRecord['visibility'];
    contentType: VideoRecord['contentType'];
    sizeBytes: number;
    productId: string | null;
    shareToken: string | null;
    sourceKey: string;
    partSize: number;
    sessionExpiresAt: Date;
    now: Date;
  }): Promise<InsertUploadingResult> {
    // Transaction-scoped: released at commit, so the quota holds under `Promise.all` (AS-05).
    await this.sql(
      `SELECT pg_advisory_xact_lock(hashtextextended('video-pending:' || $1::text, 0))`,
      [input.shopId],
    );
    const [{ count }] = await this.sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Video" WHERE "shopId" = $1 AND "status" = 'UPLOADING'`,
      [input.shopId],
    );
    if (Number(count) >= MAX_PENDING_UPLOADS)
      return { ok: false, current: Number(count) };
    const [row] = await this.sql<Record<string, unknown>>(
      `INSERT INTO "Video" ("id", "shopId", "uploaderId", "title", "visibility", "status", "sourceKey", "sizeBytes", "contentType",
                            "partSize", "sessionExpiresAt", "shareToken", "productId", "createdAt", "updatedAt")
       VALUES ($13, $1, $2, $3, $4, 'UPLOADING', $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING ${COLUMNS}`,
      [
        input.shopId,
        input.uploaderId,
        input.title,
        input.visibility,
        input.sourceKey,
        input.sizeBytes,
        input.contentType,
        input.partSize,
        input.sessionExpiresAt,
        input.shareToken,
        input.productId,
        input.now,
        input.id,
      ],
    );
    await this.history(
      row.id as string,
      null,
      'UPLOADING',
      { type: 'user', id: input.uploaderId },
      input.now,
    );
    return { ok: true, video: toVideoRecord(row) };
  }

  async setUploadId(id: string, uploadId: string): Promise<boolean> {
    const rows = await this.sql(
      `UPDATE "Video" SET "uploadId" = $2 WHERE "id" = $1 AND "status" = 'UPLOADING' RETURNING "id"`,
      [id, uploadId],
    );
    return rows.length === 1;
  }

  async claimUploaded(id: string, actor: VideoActor, now: Date) {
    const moved = await this.move({
      id,
      from: ['UPLOADING'],
      to: 'UPLOADED',
      actor,
      now,
    });
    return moved?.video ?? null;
  }

  async expire(id: string, actor: VideoActor, now: Date, olderThan?: Date) {
    const moved = await this.move({
      id,
      from: ['UPLOADING'],
      to: 'EXPIRED',
      actor,
      now,
      ...(olderThan && {
        extraWhere: `AND "sessionExpiresAt" <= $5`,
        params: [olderThan],
      }),
    });
    return moved?.video ?? null;
  }

  async startProcessing(id: string, actor: VideoActor, now: Date) {
    const moved = await this.move({
      id,
      from: ['UPLOADED'],
      to: 'PROCESSING',
      assignments: `"internalError" = NULL`,
      actor,
      now,
    });
    if (!moved) return null;
    await this.sql(
      `INSERT INTO "VideoTask" ("videoId", "name", "dependsOn", "status", "lastSentAt", "createdAt", "updatedAt")
       VALUES ($1, 'probe', '{}', 'QUEUED', $2, $2, $2) ON CONFLICT ("videoId", "name") DO NOTHING`,
      [id, now],
    );
    return moved.video;
  }

  async fail(input: {
    id: string;
    from: VideoStatus[];
    code: VideoFailureCode;
    internalError: string | null;
    actor: VideoActor;
    now: Date;
  }) {
    const moved = await this.move({
      id: input.id,
      from: input.from,
      to: 'FAILED',
      assignments: `"failureCode" = $5, "internalError" = $6`,
      params: [input.code, input.internalError?.slice(0, 500) ?? null],
      actor: input.actor,
      now: input.now,
      failureCode: input.code,
    });
    if (!moved) return null;
    const { video } = moved;
    await this.cancelOpenTasks([video.id], input.now);
    await this.append(
      VideoFailed.create(
        video.id,
        video.version,
        {
          videoId: video.id,
          videoVersion: video.version,
          shopId: video.shopId,
          uploaderId: video.uploaderId,
          failureCode: input.code,
        },
        input.now,
      ),
      input.now,
    );
    return video;
  }

  // ---- pipeline

  async lock(id: string): Promise<VideoStatus | null> {
    const [row] = await this.sql<{ status: VideoStatus }>(
      `SELECT "status" FROM "Video" WHERE "id" = $1 FOR UPDATE`,
      [id],
    );
    return row?.status ?? null;
  }

  async setInternalError(id: string, note: string | null): Promise<void> {
    await this.sql(`UPDATE "Video" SET "internalError" = $2 WHERE "id" = $1`, [
      id,
      note,
    ]);
  }

  async setProbe(
    id: string,
    probe: { durationSec: number; width: number; height: number },
  ): Promise<void> {
    await this.sql(
      `UPDATE "Video" SET "durationSec" = $2, "width" = $3, "height" = $4 WHERE "id" = $1`,
      [id, probe.durationSec, probe.width, probe.height],
    );
  }

  async publish(input: { id: string; outputs: VideoOutputs; now: Date }) {
    const moved = await this.move({
      id: input.id,
      from: ['PROCESSING'],
      to: 'READY',
      assignments: `"outputs" = $5::jsonb, "readyAt" = $4`,
      params: [JSON.stringify(input.outputs)],
      actor: { type: 'worker' },
      now: input.now,
      // every required task is finished; the `publish` task itself is the one running this call
      extraWhere: `AND NOT EXISTS (
        SELECT 1 FROM "VideoTask" t WHERE t."videoId" = "Video"."id" AND t."name" <> 'publish' AND t."status" NOT IN ('DONE', 'SKIPPED'))`,
    });
    if (!moved) return null;
    const { video } = moved;
    await this.append(
      VideoReady.create(
        video.id,
        video.version,
        {
          videoId: video.id,
          videoVersion: video.version,
          shopId: video.shopId,
          uploaderId: video.uploaderId,
          productId: video.productId,
          visibility: video.visibility,
          durationSec: video.durationSec ?? 0,
          width: video.width ?? 1,
          height: video.height ?? 1,
          renditions: input.outputs.renditions.map((r) => ({
            name: r.name,
            width: r.width,
            height: r.height,
          })),
          hasSprite: input.outputs.sprite !== null,
        },
        input.now,
      ),
      input.now,
    );
    return video;
  }

  // ---- reads

  async find(id: string) {
    const [row] = await this.sql<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM "Video" WHERE "id" = $1`,
      [id],
    );
    return row ? toVideoRecord(row) : null;
  }

  async findInShop(id: string, shopId: string) {
    const [row] = await this.sql<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM "Video" WHERE "id" = $1 AND "shopId" = $2`,
      [id, shopId],
    );
    return row ? toVideoRecord(row) : null;
  }

  async findPlayable(id: string) {
    const [row] = await this.sql<Record<string, unknown>>(
      `SELECT ${prefixed('v')}, COALESCE(s."suspended", false) AS "suspended"
         FROM "Video" v LEFT JOIN "VideoShopState" s ON s."shopId" = v."shopId"
        WHERE v."id" = $1`,
      [id],
    );
    if (!row) return null;
    const { suspended, ...video } = row;
    return { video: toVideoRecord(video), suspended: suspended === true };
  }

  async list(filter: ListFilter) {
    const params: unknown[] = [filter.shopId];
    const clauses = [`"shopId" = $1`, `"status" <> 'DELETED'`];
    if (filter.status)
      clauses.push(`"status" = $${params.push(filter.status)}`);
    if (filter.after) {
      const c = params.push(filter.after.createdAt);
      const i = params.push(filter.after.id);
      clauses.push(`("createdAt", "id") < ($${c}, $${i})`);
    }
    const rows = await this.sql<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM "Video" WHERE ${clauses.join(' AND ')}
        ORDER BY "createdAt" DESC, "id" DESC LIMIT $${params.push(filter.limit)}`,
      params,
    );
    return rows.map(toVideoRecord);
  }

  async listPublicByProduct(productId: string, limit: number) {
    const rows = await this.sql<Record<string, unknown>>(
      `SELECT ${prefixed('v')} FROM "Video" v
        WHERE v."productId" = $1 AND v."status" = 'READY' AND v."visibility" = 'public'
        ORDER BY v."createdAt" DESC, v."id" DESC LIMIT $2`,
      [productId, limit],
    );
    return rows.map(toVideoRecord);
  }

  async shopSuspended(shopId: string): Promise<boolean> {
    const [row] = await this.sql<{ suspended: boolean }>(
      `SELECT "suspended" FROM "VideoShopState" WHERE "shopId" = $1`,
      [shopId],
    );
    return row?.suspended === true;
  }

  // ---- management

  async patch(input: {
    id: string;
    shopId: string;
    expectedVersion: number;
    title?: string;
    productId?: string | null;
    now: Date;
  }): Promise<PatchResult> {
    if (input.productId)
      await this.sql(
        `SELECT pg_advisory_xact_lock(hashtextextended('video-product:' || $1::text, 0))`,
        [input.productId],
      );
    const [current] = await this.sql<{ status: VideoStatus; version: number }>(
      `SELECT "status", "version" FROM "Video" WHERE "id" = $1 AND "shopId" = $2 AND "status" <> 'DELETED' FOR UPDATE`,
      [input.id, input.shopId],
    );
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status === 'EXPIRED')
      return { ok: false, reason: 'upload_expired' };
    if (current.version !== input.expectedVersion)
      return {
        ok: false,
        reason: 'version_conflict',
        currentVersion: current.version,
      };
    if (input.productId) {
      const [{ count }] = await this.sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM "Video" WHERE "productId" = $1 AND "status" <> 'DELETED' AND "id" <> $2`,
        [input.productId, input.id],
      );
      if (Number(count) >= MAX_VIDEOS_PER_PRODUCT)
        return { ok: false, reason: 'product_video_limit' };
    }
    const sets: string[] = [];
    const params: unknown[] = [input.id, input.shopId, input.now];
    if (input.title !== undefined)
      sets.push(`"title" = $${params.push(input.title)}`);
    if (input.productId !== undefined)
      sets.push(`"productId" = $${params.push(input.productId)}`);
    const [row] = await this.sql<Record<string, unknown>>(
      `UPDATE "Video" SET ${sets.join(', ')}${sets.length ? ', ' : ''}"version" = "version" + 1, "updatedAt" = $3
        WHERE "id" = $1 AND "shopId" = $2 RETURNING ${COLUMNS}`,
      params,
    );
    return { ok: true, video: toVideoRecord(row) };
  }

  async retry(input: {
    id: string;
    shopId: string;
    actor: VideoActor;
    now: Date;
  }): Promise<RetryResult> {
    const [current] = await this.sql<{
      status: VideoStatus;
      failureCode: VideoFailureCode | null;
      retryCount: number;
      objectsPurgedAt: Date | null;
    }>(
      `SELECT "status", "failureCode", "retryCount", "objectsPurgedAt" FROM "Video"
        WHERE "id" = $1 AND "shopId" = $2 AND "status" <> 'DELETED' FOR UPDATE`,
      [input.id, input.shopId],
    );
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status !== 'FAILED')
      return { ok: false, reason: 'invalid_state', status: current.status };
    if (!isRetryable(current.failureCode))
      return { ok: false, reason: 'not_retryable' };
    if (current.objectsPurgedAt) return { ok: false, reason: 'source_purged' };
    if (current.retryCount >= MAX_VIDEO_RETRIES)
      return { ok: false, reason: 'retry_limit' };
    const moved = await this.move({
      id: input.id,
      shopId: input.shopId,
      from: ['FAILED'],
      to: 'PROCESSING',
      assignments: `"failureCode" = NULL, "internalError" = NULL, "retryCount" = v."retryCount" + 1`,
      actor: input.actor,
      now: input.now,
    });
    if (!moved) return { ok: false, reason: 'invalid_state' };
    // Done tasks are kept: the video resumes from the last finished step.
    await this.sql(
      `UPDATE "VideoTask" SET "status" = 'PENDING', "attempts" = 0, "claimedAttempt" = NULL, "leaseExpiresAt" = NULL,
                "internalError" = NULL, "updatedAt" = $2
        WHERE "videoId" = $1 AND "status" IN ('FAILED', 'CANCELLED')`,
      [input.id, input.now],
    );
    const nodes = await this.sql<{
      name: string;
      dependsOn: string[];
      status: TaskStatus;
    }>(
      `SELECT "name", "dependsOn", "status" FROM "VideoTask" WHERE "videoId" = $1`,
      [input.id],
    );
    const ready = readyTasks(
      nodes.map((n) => ({ name: n.name, deps: n.dependsOn, status: n.status })),
    );
    if (ready.length)
      await this.sql(
        `UPDATE "VideoTask" SET "status" = 'QUEUED', "lastSentAt" = $3, "updatedAt" = $3
          WHERE "videoId" = $1 AND "name" = ANY($2::text[]) AND "status" = 'PENDING'`,
        [input.id, ready, input.now],
      );
    return { ok: true, video: moved.video, ready };
  }

  async softDelete(input: {
    id: string;
    shopId: string | null;
    actor: VideoActor;
    now: Date;
  }) {
    const moved = await this.move({
      id: input.id,
      shopId: input.shopId,
      from: [
        'UPLOADING',
        'UPLOADED',
        'PROCESSING',
        'READY',
        'FAILED',
        'EXPIRED',
      ],
      to: 'DELETED',
      actor: input.actor,
      now: input.now,
    });
    if (!moved) return null;
    await this.cancelOpenTasks([input.id], input.now);
    await this.append(
      VideoDeleted.create(
        moved.video.id,
        moved.video.version,
        {
          videoId: moved.video.id,
          videoVersion: moved.video.version,
          shopId: moved.video.shopId,
          productId: moved.video.productId,
        },
        input.now,
      ),
      input.now,
    );
    return moved;
  }

  // ---- consumers

  async clearProduct(productId: string, shopId: string, now: Date) {
    const rows = await this.sql(
      `UPDATE "Video" SET "productId" = NULL, "version" = "version" + 1, "updatedAt" = $3
        WHERE "productId" = $1 AND "shopId" = $2 AND "status" <> 'DELETED' RETURNING "id"`,
      [productId, shopId, now],
    );
    return rows.length;
  }

  async deleteShopBatch(shopId: string, limit: number, now: Date) {
    const rows = await this.sql<Record<string, unknown>>(
      `WITH picked AS (
         SELECT "id", "status" FROM "Video" WHERE "shopId" = $1 AND "status" <> 'DELETED' ORDER BY "id" LIMIT $2 FOR UPDATE
       ), upd AS (
         UPDATE "Video" v SET "status" = 'DELETED', "version" = v."version" + 1, "updatedAt" = $3
           FROM picked WHERE v."id" = picked."id"
         RETURNING ${prefixed('v')}, picked."status" AS "prevStatus"
       ) SELECT * FROM upd`,
      [shopId, limit, now],
    );
    if (rows.length === 0) return 0;
    const moved = rows.map(({ prevStatus, ...row }) => ({
      video: toVideoRecord(row),
      previous: prevStatus as VideoStatus,
    }));
    await this.sql(
      `INSERT INTO "VideoStatusHistory" ("videoId", "fromStatus", "toStatus", "actorType", "createdAt")
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])`,
      [
        moved.map((m) => m.video.id),
        moved.map((m) => m.previous),
        moved.map(() => 'DELETED'),
        moved.map(() => 'system'),
        moved.map(() => now),
      ],
    );
    await this.cancelOpenTasks(
      moved.map((m) => m.video.id),
      now,
    );
    await appendWithExecutor(
      { query: (text, params) => this.sql(text, params) },
      moved.map(({ video }) =>
        VideoDeleted.create(
          video.id,
          video.version,
          {
            videoId: video.id,
            videoVersion: video.version,
            shopId: video.shopId,
            productId: video.productId,
          },
          now,
        ),
      ),
      { now },
    );
    return moved.length;
  }

  async upsertShopState(input: {
    shopId: string;
    suspended: boolean;
    shopVersion: number;
    now: Date;
  }) {
    await this.sql(
      `INSERT INTO "VideoShopState" ("shopId", "suspended", "shopVersion", "updatedAt") VALUES ($1, $2, $3, $4)
       ON CONFLICT ("shopId") DO UPDATE SET "suspended" = EXCLUDED."suspended", "shopVersion" = EXCLUDED."shopVersion", "updatedAt" = EXCLUDED."updatedAt"
        WHERE EXCLUDED."shopVersion" > "VideoShopState"."shopVersion"`,
      [input.shopId, input.suspended, input.shopVersion, input.now],
    );
  }

  // ---- jobs

  private async listBy(
    where: string,
    params: unknown[],
    order: string,
    limit: number,
  ) {
    const rows = await this.sql<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM "Video" WHERE ${where} ORDER BY ${order} LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return rows.map(toVideoRecord);
  }

  listExpiredUploads(now: Date, limit: number) {
    return this.listBy(
      `"status" = 'UPLOADING' AND "sessionExpiresAt" <= $1`,
      [now],
      `"sessionExpiresAt"`,
      limit,
    );
  }

  listStuckUploaded(before: Date, limit: number) {
    return this.listBy(
      `"status" = 'UPLOADED' AND "updatedAt" <= $1`,
      [before],
      `"updatedAt"`,
      limit,
    );
  }

  listProcessingSince(before: Date, limit: number) {
    return this.listBy(
      `"status" = 'PROCESSING' AND (
         SELECT max(h."createdAt") FROM "VideoStatusHistory" h WHERE h."videoId" = "Video"."id" AND h."toStatus" = 'PROCESSING') <= $1`,
      [before],
      `"updatedAt"`,
      limit,
    );
  }

  listPurgeable(input: { failedBefore: Date; limit: number }) {
    return this.listBy(
      `("objectsPurgedAt" IS NULL AND ("status" IN ('DELETED', 'EXPIRED') OR ("status" = 'FAILED' AND "updatedAt" <= $1)))
        OR ("status" = 'DELETED' AND "visibility" = 'public' AND "edgePurgedAt" IS NULL)`,
      [input.failedBefore],
      `"updatedAt"`,
      input.limit,
    );
  }

  async markObjectsPurged(id: string, now: Date) {
    await this.sql(
      `UPDATE "Video" SET "objectsPurgedAt" = $2 WHERE "id" = $1`,
      [id, now],
    );
  }

  async markEdgePurged(id: string, now: Date) {
    await this.sql(`UPDATE "Video" SET "edgePurgedAt" = $2 WHERE "id" = $1`, [
      id,
      now,
    ]);
  }
}
