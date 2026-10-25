import { appendWithExecutor } from '@app/infrastructure/outbox/append-with-executor';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type { MediaPurpose } from '@marketplace-sandbox/contracts';
import {
  MediaDeleted,
  MediaDuplicateSuspected,
  MediaReady,
  MediaRejected,
} from '../domain/media-events';
import { FORCED_DELETE_FROM } from '../domain/media-status';
import type { MediaStatus } from '../domain/media-status';
import type { RejectCode } from '../domain/reject-code';
import { LEASE_MINUTES } from '../domain/upload-policy';
import type {
  Actor,
  ClaimResult,
  DuplicateScan,
  MediaRecord,
  MediaRepository,
  ReadyInput,
  SqlRunner,
} from '../domain/ports';

const COLUMNS = `"id", "shopId", "uploaderId", "purpose", "status", "originalKey", "variants", "width", "height", "rejectCode", "attempts", "leaseUntil", "version", "uploadedAt", "createdAt", "updatedAt"`;
const prefixed = (alias: string) =>
  COLUMNS.split(', ')
    .map((c) => `${alias}.${c}`)
    .join(', ');

const toRecord = (row: Record<string, unknown>): MediaRecord => ({
  ...(row as unknown as MediaRecord),
  leaseUntil: row.leaseUntil ? new Date(row.leaseUntil as string) : null,
  uploadedAt: row.uploadedAt ? new Date(row.uploadedAt as string) : null,
  createdAt: new Date(row.createdAt as string),
  updatedAt: new Date(row.updatedAt as string),
});

const actorColumns = (actor: Actor): [string, string | null] => [
  actor.type,
  actor.type === 'user' ? actor.id : null,
];

/**
 * Every statement of the photo tables (S29 D-6): one repository for the Nest API, worker and projector (runner built
 * from the CLS transaction) and for the framework-free Lambda (runner over a `pg` client inside its own BEGIN/COMMIT).
 * A transition is one conditional `UPDATE … WHERE id = $ AND status = ANY(from)` that must return one row, plus its
 * history row and its outbox event in the same transaction (III.7, IX.6). No JOIN on another domain's table (IX.4).
 */
export class PgMediaRepository implements MediaRepository {
  constructor(private readonly sql: SqlRunner) {}

  private append(event: EventEnvelope, now: Date): Promise<void> {
    return appendWithExecutor(
      { query: (text, params) => this.sql(text, params) },
      event,
      { now },
    );
  }

  private history(
    mediaId: string,
    from: string | null,
    to: MediaStatus,
    actor: Actor,
    now: Date,
    rejectCode: RejectCode | null = null,
  ): Promise<unknown[]> {
    const [actorType, actorId] = actorColumns(actor);
    return this.sql(
      `INSERT INTO "MediaStatusHistory" ("mediaId", "fromStatus", "toStatus", "actorType", "actorId", "rejectCode", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [mediaId, from, to, actorType, actorId, rejectCode, now],
    );
  }

  /** The common transition: lock the row in one of `from`, update it, write the history row. */
  private async move(input: {
    id: string;
    from: MediaStatus[];
    to: MediaStatus;
    assignments?: string;
    params?: unknown[];
    actor: Actor;
    now: Date;
    rejectCode?: RejectCode;
  }): Promise<MediaRecord | null> {
    const rows = await this.sql<Record<string, unknown>>(
      `WITH old AS (
         SELECT "id", "status" FROM "Media" WHERE "id" = $1 AND "status" = ANY($2::text[]) FOR UPDATE
       ), upd AS (
         UPDATE "Media" m SET "status" = $3, "version" = m."version" + 1, "updatedAt" = $4${input.assignments ? `, ${input.assignments}` : ''}
           FROM old WHERE m."id" = old."id"
         RETURNING ${prefixed('m')}, old."status" AS "prevStatus"
       ) SELECT * FROM upd`,
      [input.id, input.from, input.to, input.now, ...(input.params ?? [])],
    );
    if (rows.length === 0) return null;
    const { prevStatus, ...row } = rows[0];
    await this.history(
      input.id,
      prevStatus as string,
      input.to,
      input.actor,
      input.now,
      input.rejectCode ?? null,
    );
    return toRecord(row);
  }

  // ---- upload

  async countPending(
    uploaderId: string,
    shopId: string | null,
  ): Promise<number> {
    const [row] = await this.sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Media"
        WHERE "uploaderId" = $1 AND "status" = 'PENDING_UPLOAD' AND "shopId" IS NOT DISTINCT FROM $2::uuid`,
      [uploaderId, shopId],
    );
    return Number(row.count);
  }

  /**
   * The pending-upload quota as one atomic step: a transaction-scoped advisory lock per uploader and shop makes the
   * count and the insert one unit, so a hundred presigns at once cannot pass the same count (S29 AS-04). Call it inside
   * `tx`; the lock is released at commit.
   */
  async reservePending(input: {
    shopId: string | null;
    uploaderId: string;
    purpose: MediaPurpose;
    originalKey: string;
    now: Date;
    limit: number;
  }): Promise<{ ok: true; media: MediaRecord } | { ok: false; current: number }> {
    await this.sql(
      `SELECT pg_advisory_xact_lock(hashtextextended('media-pending:' || $1::text || ':' || COALESCE($2::text, ''), 0))`,
      [input.uploaderId, input.shopId],
    );
    const current = await this.countPending(input.uploaderId, input.shopId);
    if (current >= input.limit) return { ok: false, current };
    return { ok: true, media: await this.insertPending(input) };
  }

  async insertPending(input: {
    shopId: string | null;
    uploaderId: string;
    purpose: MediaPurpose;
    originalKey: string;
    now: Date;
  }): Promise<MediaRecord> {
    const [row] = await this.sql<Record<string, unknown>>(
      `INSERT INTO "Media" ("shopId", "uploaderId", "purpose", "originalKey", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING ${COLUMNS}`,
      [
        input.shopId,
        input.uploaderId,
        input.purpose,
        input.originalKey,
        input.now,
      ],
    );
    await this.history(
      row.id as string,
      null,
      'PENDING_UPLOAD',
      { type: 'user', id: input.uploaderId },
      input.now,
    );
    return toRecord(row);
  }

  async findForUploader(
    id: string,
    uploaderId: string,
  ): Promise<MediaRecord | null> {
    const [row] = await this.sql<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM "Media" WHERE "id" = $1 AND "uploaderId" = $2 AND "status" <> 'DELETED'`,
      [id, uploaderId],
    );
    return row ? toRecord(row) : null;
  }

  markUploaded(
    id: string,
    actor: Actor,
    now: Date,
  ): Promise<MediaRecord | null> {
    return this.move({
      id,
      from: ['PENDING_UPLOAD'],
      to: 'UPLOADED',
      assignments: `"uploadedAt" = $4`,
      actor,
      now,
    });
  }

  async markRejected(input: {
    id: string;
    from: MediaStatus[];
    code: RejectCode;
    actor: Actor;
    now: Date;
  }): Promise<MediaRecord | null> {
    const row = await this.move({
      id: input.id,
      from: input.from,
      to: 'REJECTED',
      assignments: `"rejectCode" = $5, "leaseUntil" = NULL`,
      params: [input.code],
      actor: input.actor,
      now: input.now,
      rejectCode: input.code,
    });
    if (row)
      await this.append(
        MediaRejected.create(
          row.id,
          row.version,
          {
            mediaId: row.id,
            mediaVersion: row.version,
            shopId: row.shopId,
            uploaderId: row.uploaderId,
            purpose: row.purpose,
            code: input.code,
          },
          input.now,
        ),
        input.now,
      );
    return row;
  }

  // ---- processing

  async claim(originalKey: string, now: Date): Promise<ClaimResult> {
    const rows = await this.sql<Record<string, unknown>>(
      `WITH old AS (
         SELECT "id", "status" FROM "Media"
          WHERE "originalKey" = $1
            AND ("status" IN ('PENDING_UPLOAD', 'UPLOADED') OR ("status" = 'PROCESSING' AND "leaseUntil" <= $2))
          FOR UPDATE
       ), upd AS (
         UPDATE "Media" m SET "status" = 'PROCESSING', "attempts" = m."attempts" + 1,
                "leaseUntil" = $2::timestamptz + make_interval(mins => $3), "version" = m."version" + 1, "updatedAt" = $2
           FROM old WHERE m."id" = old."id"
         RETURNING ${prefixed('m')}, old."status" AS "prevStatus"
       ) SELECT * FROM upd`,
      [originalKey, now, LEASE_MINUTES],
    );
    if (rows.length > 0) {
      const { prevStatus, ...row } = rows[0];
      await this.history(
        row.id as string,
        prevStatus as string,
        'PROCESSING',
        { type: 'worker' },
        now,
      );
      return { outcome: 'claimed', media: toRecord(row) };
    }
    const [current] = await this.sql<{
      status: string;
      leaseUntil: Date | null;
    }>(`SELECT "status", "leaseUntil" FROM "Media" WHERE "originalKey" = $1`, [
      originalKey,
    ]);
    if (!current) return { outcome: 'skipped', reason: 'unknown' };
    if (current.status === 'PROCESSING') return { outcome: 'busy' };
    return { outcome: 'skipped', reason: 'terminal' };
  }

  async releaseLease(id: string, now: Date): Promise<void> {
    await this.sql(
      `UPDATE "Media" SET "leaseUntil" = $2 WHERE "id" = $1 AND "status" = 'PROCESSING'`,
      [id, now],
    );
  }

  async lockBands(bands: [number, number, number, number]): Promise<void> {
    // Ascending lock keys so two workers never wait on each other in a cycle.
    const keys = await this.sql<{ key: string }>(
      `SELECT hashtextextended('media.dhash.b' || i || ':' || v, 0)::text AS key
         FROM unnest($1::int[], $2::int[]) AS t(i, v) ORDER BY hashtextextended('media.dhash.b' || i || ':' || v, 0)`,
      [[0, 1, 2, 3], bands],
    );
    for (const { key } of keys)
      await this.sql(`SELECT pg_advisory_xact_lock($1::bigint)`, [key]);
  }

  async scanDuplicates(
    bands: [number, number, number, number],
    shopId: string,
    cap: number,
  ): Promise<DuplicateScan> {
    const found = new Map<
      string,
      { id: string; hash: string; shopId: string }
    >();
    let truncatedBands = 0;
    for (const [index, value] of bands.entries()) {
      const rows = await this.sql<{
        id: string;
        dhash: string;
        shopId: string;
      }>(
        `SELECT "id", "dhash", "shopId" FROM "Media"
          WHERE "status" = 'READY' AND "purpose" = 'product' AND "shopId" <> $1 AND "dhashB${index}" = $2
          ORDER BY "id" LIMIT $3`,
        [shopId, value, cap],
      );
      if (rows.length >= cap) truncatedBands += 1;
      for (const row of rows)
        found.set(row.id, { id: row.id, hash: row.dhash, shopId: row.shopId });
    }
    return { candidates: [...found.values()], truncatedBands };
  }

  async markReady(input: ReadyInput, now: Date): Promise<MediaRecord | null> {
    const bands = input.hash?.bands ?? [null, null, null, null];
    const row = await this.move({
      id: input.id,
      from: ['PROCESSING'],
      to: 'READY',
      assignments: `"variants" = $5::jsonb, "width" = $6, "height" = $7, "dhash" = $8,
        "dhashB0" = $9, "dhashB1" = $10, "dhashB2" = $11, "dhashB3" = $12,
        "possibleDuplicateOf" = $13, "duplicateDistance" = $14, "duplicateAt" = $15, "leaseUntil" = NULL`,
      params: [
        JSON.stringify(input.variants),
        input.width,
        input.height,
        input.hash?.dhash ?? null,
        ...bands,
        input.duplicate?.mediaId ?? null,
        input.duplicate?.distance ?? null,
        input.duplicate ? now : null,
      ],
      actor: { type: 'worker' },
      now,
    });
    if (!row) return null;
    await this.append(
      MediaReady.create(
        row.id,
        row.version,
        {
          mediaId: row.id,
          mediaVersion: row.version,
          shopId: row.shopId,
          uploaderId: row.uploaderId,
          purpose: row.purpose,
          width: input.width,
          height: input.height,
          variants: input.variants,
          duplicateSuspected: input.duplicate !== null,
        },
        now,
      ),
      now,
    );
    if (input.duplicate && row.shopId)
      await this.append(
        MediaDuplicateSuspected.create(
          row.id,
          row.version,
          {
            mediaId: row.id,
            shopId: row.shopId,
            matchedMediaId: input.duplicate.mediaId,
            matchedShopId: input.duplicate.shopId,
            distance: input.duplicate.distance,
          },
          now,
        ),
        now,
      );
    return row;
  }

  // ---- reads

  async findById(id: string): Promise<MediaRecord | null> {
    const [row] = await this.sql<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM "Media" WHERE "id" = $1 AND "status" <> 'DELETED'`,
      [id],
    );
    return row ? toRecord(row) : null;
  }

  async findForShop(id: string, shopId: string): Promise<MediaRecord | null> {
    const [row] = await this.sql<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM "Media" WHERE "id" = $1 AND "shopId" = $2 AND "status" <> 'DELETED'`,
      [id, shopId],
    );
    return row ? toRecord(row) : null;
  }

  async findReadyByIds(
    ids: string[],
    filters: {
      uploaderId?: string;
      shopId?: string;
      purpose?: MediaPurpose;
    } = {},
  ): Promise<MediaRecord[]> {
    if (ids.length === 0) return [];
    const params: unknown[] = [ids];
    const where = ['"id" = ANY($1::uuid[])', `"status" = 'READY'`];
    if (filters.uploaderId)
      where.push(`"uploaderId" = $${params.push(filters.uploaderId)}`);
    if (filters.shopId)
      where.push(`"shopId" = $${params.push(filters.shopId)}`);
    if (filters.purpose)
      where.push(`"purpose" = $${params.push(filters.purpose)}`);
    const rows = await this.sql<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM "Media" WHERE ${where.join(' AND ')}`,
      params,
    );
    return rows.map(toRecord);
  }

  // ---- delete and lifecycle

  async lockById(id: string): Promise<MediaRecord | null> {
    const [row] = await this.sql<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM "Media" WHERE "id" = $1 AND "status" <> 'DELETED' FOR UPDATE`,
      [id],
    );
    return row ? toRecord(row) : null;
  }

  async markDeleted(input: {
    id: string;
    from: MediaStatus[];
    actor: Actor;
    now: Date;
  }): Promise<MediaRecord | null> {
    const row = await this.move({
      id: input.id,
      from: input.from,
      to: 'DELETED',
      assignments: `"leaseUntil" = NULL`,
      actor: input.actor,
      now: input.now,
    });
    if (row) await this.appendDeleted(row, input.now);
    return row;
  }

  private appendDeleted(row: MediaRecord, now: Date): Promise<void> {
    return this.append(
      MediaDeleted.create(
        row.id,
        row.version,
        {
          mediaId: row.id,
          mediaVersion: row.version,
          shopId: row.shopId,
          purpose: row.purpose,
        },
        now,
      ),
      now,
    );
  }

  async productsUsing(
    mediaId: string,
    shopId: string | null,
  ): Promise<string[]> {
    if (!shopId) {
      const rows = await this.sql<{ productId: string }>(
        `SELECT "productId" FROM "ProductMedia" WHERE "mediaId" = $1 LIMIT 1`,
        [mediaId],
      );
      return rows.map((r) => r.productId);
    }
    const rows = await this.sql<{ productId: string }>(
      `SELECT pm."productId" FROM "ProductMedia" pm
         JOIN "ProductGallery" g ON g."productId" = pm."productId" AND g."shopId" = $2
        WHERE pm."mediaId" = $1 ORDER BY pm."productId"`,
      [mediaId, shopId],
    );
    return rows.map((r) => r.productId);
  }

  async expirePending(
    cutoff: Date,
    now: Date,
    limit: number,
  ): Promise<MediaRecord[]> {
    const picked = await this.sql<{ id: string }>(
      `SELECT "id" FROM "Media" WHERE "status" = 'PENDING_UPLOAD' AND "createdAt" < $1
        ORDER BY "createdAt" LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [cutoff, limit],
    );
    const expired: MediaRecord[] = [];
    for (const { id } of picked) {
      const row = await this.move({
        id,
        from: ['PENDING_UPLOAD'],
        to: 'EXPIRED',
        assignments: `"leaseUntil" = NULL`,
        actor: { type: 'system' },
        now,
      });
      if (row) expired.push(row);
    }
    return expired;
  }

  async findStuck(input: {
    uploadedBefore: Date;
    leaseExpiredBefore: Date;
    touchedBefore: Date;
    limit: number;
  }): Promise<MediaRecord[]> {
    const rows = await this.sql<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM "Media"
        WHERE (("status" = 'UPLOADED' AND "uploadedAt" <= $1)
            OR ("status" = 'PROCESSING' AND "leaseUntil" <= $2))
          AND "updatedAt" < $3
        ORDER BY "updatedAt" LIMIT $4`,
      [
        input.uploadedBefore,
        input.leaseExpiredBefore,
        input.touchedBefore,
        input.limit,
      ],
    );
    return rows.map(toRecord);
  }

  async touch(ids: string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.sql(
      `UPDATE "Media" SET "updatedAt" = $2 WHERE "id" = ANY($1::uuid[])`,
      [ids, now],
    );
  }

  async findPurgeable(cutoff: Date, limit: number): Promise<MediaRecord[]> {
    const rows = await this.sql<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM "Media"
        WHERE "status" IN ('REJECTED', 'EXPIRED', 'DELETED') AND "updatedAt" < $1
        ORDER BY "updatedAt" LIMIT $2`,
      [cutoff, limit],
    );
    return rows.map(toRecord);
  }

  async liveVariantKeys(
    keys: string[],
    excludeIds: string[],
  ): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.sql<{ key: string }>(
      `SELECT DISTINCT v.value ->> 'key' AS key
         FROM "Media" m, jsonb_each(m."variants") v
        WHERE m."variants" IS NOT NULL
          AND m."status" NOT IN ('REJECTED', 'EXPIRED', 'DELETED')
          AND NOT (m."id" = ANY($2::uuid[]))
          AND v.value ->> 'key' = ANY($1::text[])`,
      [keys, excludeIds],
    );
    return new Set(rows.map((r) => r.key));
  }

  async purge(id: string): Promise<boolean> {
    await this.sql(`DELETE FROM "ProductMedia" WHERE "mediaId" = $1`, [id]);
    await this.sql(`DELETE FROM "MediaStatusHistory" WHERE "mediaId" = $1`, [
      id,
    ]);
    const removed = await this.sql(
      `DELETE FROM "Media" WHERE "id" = $1 RETURNING "id"`,
      [id],
    );
    return removed.length > 0;
  }

  // ---- consumers

  async deleteShopPhotos(shopId: string, now: Date): Promise<number> {
    const picked = await this.sql<{ id: string }>(
      `SELECT "id" FROM "Media" WHERE "shopId" = $1 AND "status" <> 'DELETED' ORDER BY "id" FOR UPDATE`,
      [shopId],
    );
    let count = 0;
    for (const { id } of picked) {
      // A deleted shop forces `DELETED` from any live status (AS-40): not a user transition, so it does not go through
      // the AS-49 table; a late worker run for the key answers SKIPPED because `DELETED` is final.
      const row = await this.markDeleted({
        id,
        from: [...FORCED_DELETE_FROM],
        actor: { type: 'system' },
        now,
      });
      if (row) count += 1;
    }
    return count;
  }
}
