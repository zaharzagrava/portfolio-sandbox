import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  VersionRepository,
  VersionRow,
  VersionSummary,
} from '../domain/ports';
import { num, one, rows } from './sql';

/**
 * `StoryVersion` (own table). Rows are written once by `insertFromDrafts` and never updated: there is no update path
 * (FR-010, immutable versions).
 */
@Injectable()
export class SequelizeVersionRepository implements VersionRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async latest(shopId: string, storyId: string): Promise<number> {
    const row = await one<{ v: number | string | null }>(
      this.db,
      `SELECT COALESCE(MAX("version"), 0) AS v FROM "StoryVersion" WHERE "storyId" = $storyId AND "shopId" = $shopId`,
      { shopId, storyId },
    );
    return num(row?.v);
  }

  async insertFromDrafts(input: {
    shopId: string;
    storyId: string;
    version: number;
    now: Date;
    publishedBy: string | null;
  }): Promise<string[]> {
    const written = await rows<{ locale: string }>(
      this.db,
      `INSERT INTO "StoryVersion" ("storyId", "shopId", "version", "locale", "title", "blocks", "seo", "createdAt", "publishedAt", "publishedBy")
       SELECT d."storyId", d."shopId", $version::int, d."locale", d."title", d."blocks", d."seo", $now, $now, $publishedBy::uuid
         FROM "StoryDraft" d WHERE d."storyId" = $storyId AND d."shopId" = $shopId
       RETURNING "locale"`,
      input,
    );
    return written.map((r) => r.locale).sort();
  }

  rows(
    shopId: string,
    storyId: string,
    version: number,
  ): Promise<VersionRow[]> {
    return rows<VersionRow>(
      this.db,
      `SELECT "storyId", "shopId", "version", "locale", "title", "blocks", "seo", "publishedAt", "publishedBy"
         FROM "StoryVersion"
        WHERE "storyId" = $storyId AND "shopId" = $shopId AND "version" = $version
        ORDER BY "locale" COLLATE "C"`,
      { shopId, storyId, version },
    );
  }

  list(
    shopId: string,
    storyId: string,
    options: { limit: number; before?: number },
  ): Promise<VersionSummary[]> {
    return rows<VersionSummary>(
      this.db,
      `SELECT "version", array_agg("locale" ORDER BY "locale" COLLATE "C") AS "locales",
              max("publishedAt") AS "publishedAt", (array_agg("publishedBy"::text))[1] AS "publishedBy"
         FROM "StoryVersion"
        WHERE "storyId" = $storyId AND "shopId" = $shopId AND ($before::int IS NULL OR "version" < $before::int)
        GROUP BY "version" ORDER BY "version" DESC LIMIT $limit`,
      { shopId, storyId, before: options.before ?? null, limit: options.limit },
    );
  }
}
