import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { CursorRepository, CursorState } from '../../domain/ports';
import { count, one, rows, toDate } from './sql';

/** `SyncCursor` (own table): watermark, page checkpoint and the fenced lease. */
@Injectable()
export class SequelizeCursorRepository implements CursorRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async read(
    integrationId: string,
    entity: string,
  ): Promise<CursorState | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT "integrationId", "entity", "watermark", "pageCursor", "leaseHolder", "leaseExpiresAt", "fence"
         FROM "SyncCursor" WHERE "integrationId" = :integrationId AND "entity" = :entity`,
      { integrationId, entity },
    );
    if (!r) return null;
    return {
      integrationId,
      entity,
      watermark: toDate(r.watermark),
      pageCursor: (r.pageCursor ?? null) as string | null,
      leaseHolder: (r.leaseHolder ?? null) as string | null,
      leaseExpiresAt: toDate(r.leaseExpiresAt),
      fence: Number(r.fence),
    };
  }

  async markAlert(
    integrationId: string,
    entity: string,
    now: Date,
  ): Promise<boolean> {
    const r = await one(
      this.db,
      `INSERT INTO "SyncCursor" ("integrationId", "entity", "fence", "updatedAt")
       VALUES (:integrationId, :entity, 0, :now)
       ON CONFLICT ("integrationId", "entity") DO NOTHING
       RETURNING 1 AS "ok"`,
      { integrationId, entity, now },
    );
    return r !== null;
  }

  async clearAlert(integrationId: string, entity: string): Promise<void> {
    await rows(
      this.db,
      `DELETE FROM "SyncCursor" WHERE "integrationId" = :integrationId AND "entity" = :entity RETURNING 1`,
      { integrationId, entity },
    );
  }

  async reset(integrationId: string, entity: string): Promise<void> {
    await rows(
      this.db,
      `INSERT INTO "SyncCursor" ("integrationId", "entity", "fence", "updatedAt")
       VALUES (:integrationId, :entity, 0, now())
       ON CONFLICT ("integrationId", "entity") DO UPDATE SET
         "watermark" = NULL, "pageCursor" = NULL, "fence" = "SyncCursor"."fence" + 1, "updatedAt" = now()
       RETURNING 1`,
      { integrationId, entity },
    );
  }

  async claimLease(
    integrationId: string,
    entity: string,
    holder: string,
    ttlMs: number,
    now: Date,
  ): Promise<number | null> {
    const r = await one<{ fence: string }>(
      this.db,
      `INSERT INTO "SyncCursor" ("integrationId", "entity", "leaseHolder", "leaseExpiresAt", "fence", "updatedAt")
       VALUES (:integrationId, :entity, :holder, :expiresAt, 1, :now)
       ON CONFLICT ("integrationId", "entity") DO UPDATE SET
         "leaseHolder" = EXCLUDED."leaseHolder",
         "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
         "fence" = "SyncCursor"."fence" + 1,
         "updatedAt" = :now
       WHERE "SyncCursor"."leaseExpiresAt" IS NULL OR "SyncCursor"."leaseExpiresAt" <= :now
       RETURNING "fence"`,
      {
        integrationId,
        entity,
        holder,
        now,
        expiresAt: new Date(now.getTime() + ttlMs),
      },
    );
    return r ? Number(r.fence) : null;
  }

  async renewLease(
    integrationId: string,
    entity: string,
    holder: string,
    fence: number,
    ttlMs: number,
    now: Date,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "SyncCursor" SET "leaseExpiresAt" = :expiresAt, "updatedAt" = :now
          WHERE "integrationId" = :integrationId AND "entity" = :entity
            AND "leaseHolder" = :holder AND "fence" = :fence RETURNING 1`,
        {
          integrationId,
          entity,
          holder,
          fence,
          now,
          expiresAt: new Date(now.getTime() + ttlMs),
        },
      )) > 0
    );
  }

  async releaseLease(
    integrationId: string,
    entity: string,
    holder: string,
    fence: number,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "SyncCursor" SET "leaseHolder" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
          WHERE "integrationId" = :integrationId AND "entity" = :entity
            AND "leaseHolder" = :holder AND "fence" = :fence RETURNING 1`,
        { integrationId, entity, holder, fence },
      )) > 0
    );
  }

  async checkpoint(
    integrationId: string,
    entity: string,
    fence: number,
    pageCursor: string | null,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "SyncCursor" SET "pageCursor" = :pageCursor, "updatedAt" = now()
          WHERE "integrationId" = :integrationId AND "entity" = :entity AND "fence" = :fence RETURNING 1`,
        { integrationId, entity, fence, pageCursor },
      )) > 0
    );
  }

  async advanceWatermark(
    integrationId: string,
    entity: string,
    fence: number,
    value: Date,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "SyncCursor" SET "watermark" = GREATEST("watermark", CAST(:value AS timestamptz)),
                "pageCursor" = NULL, "updatedAt" = now()
          WHERE "integrationId" = :integrationId AND "entity" = :entity AND "fence" = :fence RETURNING 1`,
        { integrationId, entity, fence, value },
      )) > 0
    );
  }
}
