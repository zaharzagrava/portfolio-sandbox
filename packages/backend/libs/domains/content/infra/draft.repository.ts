import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { Block, Seo } from '../domain/blocks';
import type { DraftRecord, DraftRepository } from '../domain/ports';
import { count, exec, num, one, rows } from './sql';

const COLUMNS = `d."storyId", d."shopId", d."locale", d."title", d."blocks", d."seo", d."revision", d."updatedAt"`;

/** `StoryDraft` (own table). Every statement carries the shop; the revision decides every update (FR-002). */
@Injectable()
export class SequelizeDraftRepository implements DraftRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  list(shopId: string, storyId: string): Promise<DraftRecord[]> {
    return rows<DraftRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "StoryDraft" d
        WHERE d."storyId" = $storyId AND d."shopId" = $shopId ORDER BY d."locale" COLLATE "C"`,
      { shopId, storyId },
    );
  }

  find(
    shopId: string,
    storyId: string,
    locale: string,
  ): Promise<DraftRecord | null> {
    return one<DraftRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "StoryDraft" d
        WHERE d."storyId" = $storyId AND d."shopId" = $shopId AND d."locale" = $locale`,
      { shopId, storyId, locale },
    );
  }

  async count(shopId: string, storyId: string): Promise<number> {
    const row = await one<{ n: string }>(
      this.db,
      `SELECT count(*) AS n FROM "StoryDraft" WHERE "storyId" = $storyId AND "shopId" = $shopId`,
      { shopId, storyId },
    );
    return num(row?.n);
  }

  insert(input: {
    shopId: string;
    storyId: string;
    locale: string;
    title: string;
    blocks: Block[];
    seo: Seo;
    now: Date;
  }): Promise<DraftRecord | null> {
    return one<DraftRecord>(
      this.db,
      `INSERT INTO "StoryDraft" ("storyId", "shopId", "locale", "title", "blocks", "seo", "revision", "updatedAt")
       VALUES ($storyId, $shopId, $locale, $title, CAST($blocks AS jsonb), CAST($seo AS jsonb), 1, $now)
       ON CONFLICT ("storyId", "locale") DO NOTHING
       RETURNING "storyId", "shopId", "locale", "title", "blocks", "seo", "revision", "updatedAt"`,
      {
        ...input,
        blocks: JSON.stringify(input.blocks),
        seo: JSON.stringify(input.seo),
      },
    );
  }

  update(input: {
    shopId: string;
    storyId: string;
    locale: string;
    expectedRevision: number;
    title: string;
    blocks: Block[];
    seo: Seo;
    now: Date;
  }): Promise<DraftRecord | null> {
    return one<DraftRecord>(
      this.db,
      `UPDATE "StoryDraft" SET "title" = $title, "blocks" = CAST($blocks AS jsonb), "seo" = CAST($seo AS jsonb),
              "revision" = "revision" + 1, "updatedAt" = $now
        WHERE "storyId" = $storyId AND "shopId" = $shopId AND "locale" = $locale AND "revision" = $expectedRevision
        RETURNING "storyId", "shopId", "locale", "title", "blocks", "seo", "revision", "updatedAt"`,
      {
        ...input,
        blocks: JSON.stringify(input.blocks),
        seo: JSON.stringify(input.seo),
      },
    );
  }

  async delete(input: {
    shopId: string;
    storyId: string;
    locale: string;
    expectedRevision: number;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `DELETE FROM "StoryDraft"
          WHERE "storyId" = $storyId AND "shopId" = $shopId AND "locale" = $locale AND "revision" = $expectedRevision
          RETURNING 1`,
        input,
      )) > 0
    );
  }

  async replaceAll(input: {
    shopId: string;
    storyId: string;
    rows: { locale: string; title: string; blocks: Block[]; seo: Seo }[];
    now: Date;
  }): Promise<void> {
    await exec(
      this.db,
      `DELETE FROM "StoryDraft"
        WHERE "storyId" = $storyId AND "shopId" = $shopId AND NOT ("locale" = ANY($locales::text[]))`,
      {
        shopId: input.shopId,
        storyId: input.storyId,
        locales: input.rows.map((r) => r.locale),
      },
    );
    for (const row of input.rows)
      await exec(
        this.db,
        `INSERT INTO "StoryDraft" ("storyId", "shopId", "locale", "title", "blocks", "seo", "revision", "updatedAt")
         VALUES ($storyId, $shopId, $locale, $title, CAST($blocks AS jsonb), CAST($seo AS jsonb), 1, $now)
         ON CONFLICT ("storyId", "locale") DO UPDATE
           SET "title" = EXCLUDED."title", "blocks" = EXCLUDED."blocks", "seo" = EXCLUDED."seo",
               "revision" = "StoryDraft"."revision" + 1, "updatedAt" = EXCLUDED."updatedAt"
         WHERE "StoryDraft"."shopId" = EXCLUDED."shopId"`,
        {
          shopId: input.shopId,
          storyId: input.storyId,
          locale: row.locale,
          title: row.title,
          blocks: JSON.stringify(row.blocks),
          seo: JSON.stringify(row.seo),
          now: input.now,
        },
      );
  }
}
