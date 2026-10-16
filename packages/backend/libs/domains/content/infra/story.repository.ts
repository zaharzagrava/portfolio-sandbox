import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { Keyset, StoryRecord, StoryRepository } from '../domain/ports';
import type { StoryStatus } from '../domain/story-status';
import { count, exec, one, rows } from './sql';

const COLUMNS = `s."id", s."shopId", s."slug", s."defaultLocale", s."status", s."publishedVersion", s."publishedAt",
  s."scheduledAt", s."scheduledBy", s."scheduleFailure", s."sitemapPosition", s."createdAt"`;

interface StoryRow extends Omit<StoryRecord, 'sitemapPosition'> {
  sitemapPosition: string | null;
}

const toRecord = (row: StoryRow): StoryRecord => ({
  ...row,
  sitemapPosition:
    row.sitemapPosition === null ? null : Number(row.sitemapPosition),
});

/** `Story` (own table). The shop is part of every lookup by ID (FR-060); only the due-schedule scan crosses shops. */
@Injectable()
export class SequelizeStoryRepository implements StoryRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async insert(input: {
    id: string;
    shopId: string;
    slug: string;
    defaultLocale: string;
    now: Date;
    limit: number;
  }): Promise<'created' | 'slug_taken' | 'limit_reached'> {
    // one create at a time per shop, released with the transaction
    await exec(
      this.db,
      `SELECT pg_advisory_xact_lock(hashtextextended($shopId::text, 27))`,
      { shopId: input.shopId },
    );
    const taken = await one<{ n: number }>(
      this.db,
      `SELECT 1 AS n FROM "Story" WHERE "shopId" = $shopId AND "slug" = $slug`,
      { shopId: input.shopId, slug: input.slug },
    );
    if (taken) return 'slug_taken';
    const used = await one<{ n: string }>(
      this.db,
      `SELECT count(*) AS n FROM "Story" WHERE "shopId" = $shopId`,
      { shopId: input.shopId },
    );
    if (Number(used?.n ?? 0) >= input.limit) return 'limit_reached';
    const inserted = await count(
      this.db,
      `INSERT INTO "Story" ("id", "shopId", "slug", "defaultLocale", "status", "createdAt")
       VALUES ($id, $shopId, $slug, $defaultLocale, 'DRAFT', $now)
       ON CONFLICT ("shopId", "slug") DO NOTHING RETURNING 1`,
      {
        id: input.id,
        shopId: input.shopId,
        slug: input.slug,
        defaultLocale: input.defaultLocale,
        now: input.now,
      },
    );
    return inserted > 0 ? 'created' : 'slug_taken';
  }

  async find(shopId: string, storyId: string): Promise<StoryRecord | null> {
    const row = await one<StoryRow>(
      this.db,
      `SELECT ${COLUMNS} FROM "Story" s WHERE s."id" = $storyId AND s."shopId" = $shopId`,
      { shopId, storyId },
    );
    return row && toRecord(row);
  }

  async lock(shopId: string, storyId: string): Promise<StoryRecord | null> {
    const row = await one<StoryRow>(
      this.db,
      `SELECT ${COLUMNS} FROM "Story" s WHERE s."id" = $storyId AND s."shopId" = $shopId FOR UPDATE`,
      { shopId, storyId },
    );
    return row && toRecord(row);
  }

  async list(
    shopId: string,
    options: { status?: StoryStatus; limit: number; after?: Keyset },
  ): Promise<StoryRecord[]> {
    const found = await rows<StoryRow>(
      this.db,
      `SELECT ${COLUMNS} FROM "Story" s
        WHERE s."shopId" = $shopId
          AND ($status::text IS NULL OR s."status" = $status::text)
          AND ($afterAt::timestamptz IS NULL OR (s."createdAt", s."id") < ($afterAt::timestamptz, $afterId::uuid))
        ORDER BY s."createdAt" DESC, s."id" DESC
        LIMIT $limit`,
      {
        shopId,
        status: options.status ?? null,
        afterAt: options.after?.createdAt ?? null,
        afterId: options.after?.id ?? null,
        limit: options.limit,
      },
    );
    return found.map(toRecord);
  }

  async markPublished(input: {
    shopId: string;
    storyId: string;
    from: StoryStatus;
    fromVersion: number | null;
    version: number;
    now: Date;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "Story" SET "status" = 'PUBLISHED', "publishedVersion" = $version, "publishedAt" = $now,
                "scheduledAt" = NULL, "scheduledBy" = NULL, "scheduleFailure" = NULL,
                "sitemapPosition" = COALESCE("sitemapPosition", nextval('story_sitemap_position_seq'))
          WHERE "id" = $storyId AND "shopId" = $shopId AND "status" = $from
            AND "publishedVersion" IS NOT DISTINCT FROM $fromVersion::int
          RETURNING 1`,
        input,
      )) > 0
    );
  }

  async markArchived(input: {
    shopId: string;
    storyId: string;
    now: Date;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "Story" SET "status" = 'ARCHIVED', "scheduledAt" = NULL, "scheduledBy" = NULL
          WHERE "id" = $storyId AND "shopId" = $shopId AND "status" = 'PUBLISHED' RETURNING 1`,
        { shopId: input.shopId, storyId: input.storyId },
      )) > 0
    );
  }

  async setSchedule(input: {
    shopId: string;
    storyId: string;
    scheduledAt: Date;
    scheduledBy: string;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "Story" SET "scheduledAt" = $scheduledAt, "scheduledBy" = $scheduledBy::uuid, "scheduleFailure" = NULL
          WHERE "id" = $storyId AND "shopId" = $shopId RETURNING 1`,
        input,
      )) > 0
    );
  }

  async clearSchedule(shopId: string, storyId: string): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "Story" SET "scheduledAt" = NULL, "scheduledBy" = NULL
          WHERE "id" = $storyId AND "shopId" = $shopId AND "scheduledAt" IS NOT NULL RETURNING 1`,
        { shopId, storyId },
      )) > 0
    );
  }

  async recordScheduleFailure(input: {
    shopId: string;
    storyId: string;
    at: Date;
    code: string;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "Story" SET "scheduledAt" = NULL, "scheduledBy" = NULL,
                "scheduleFailure" = jsonb_build_object('at', $at::text, 'code', $code::text)
          WHERE "id" = $storyId AND "shopId" = $shopId RETURNING 1`,
        { ...input, at: input.at.toISOString() },
      )) > 0
    );
  }

  async shopIdOf(storyId: string): Promise<string | null> {
    const row = await one<{ shopId: string }>(
      this.db,
      `SELECT "shopId" FROM "Story" WHERE "id" = $storyId`,
      { storyId },
    );
    return row?.shopId ?? null;
  }

  publishedSlugs(
    shopId: string,
    limit: number,
    afterId?: string,
  ): Promise<{ id: string; slug: string }[]> {
    return rows(
      this.db,
      `SELECT "id", "slug" FROM "Story"
        WHERE "shopId" = $shopId AND "status" = 'PUBLISHED' AND ($afterId::uuid IS NULL OR "id" > $afterId::uuid)
        ORDER BY "id" LIMIT $limit`,
      { shopId, limit, afterId: afterId ?? null },
    );
  }

  /**
   * The sweep's candidates: every shop (the one query of this domain that is not scoped to a shop), oldest schedule first,
   * on the partial `(scheduledAt, id)` index. The caller locks each story before it acts, so two sweeps never both publish.
   */
  claimDue(
    now: Date,
    limit: number,
  ): Promise<{ id: string; shopId: string; scheduledAt: Date }[]> {
    return rows(
      this.db,
      `SELECT "id", "shopId", "scheduledAt" FROM "Story"
        WHERE "scheduledAt" IS NOT NULL AND "scheduledAt" <= $now
        ORDER BY "scheduledAt", "id" LIMIT $limit`,
      { now, limit },
    );
  }
}
