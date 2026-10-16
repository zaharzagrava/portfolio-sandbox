import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  ShopCopy,
  ShopCopyInput,
  ShopCopyRepository,
} from '../domain/ports';
import { count, exec, one, rows } from './sql';

const COLUMNS = `"shopId", "slug", "status", "shopVersion"`;

interface CopyRow extends Omit<ShopCopy, 'shopVersion'> {
  shopVersion: string;
}
const toCopy = (row: CopyRow): ShopCopy => ({
  ...row,
  shopVersion: Number(row.shopVersion),
});

/**
 * `StoryShop` (own table): this capability's copy of a shop's public identity (R3), written only by the shop-copy
 * consumer. Status and version move forward only; the slug is set once.
 */
@Injectable()
export class SequelizeShopCopyRepository implements ShopCopyRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async upsertGuarded(input: ShopCopyInput): Promise<boolean> {
    return (
      (await count(
        this.db,
        `INSERT INTO "StoryShop" ("shopId", "slug", "status", "shopVersion")
         VALUES ($shopId, $slug::text, COALESCE($status::text, 'ACTIVE'), $shopVersion::bigint)
         ON CONFLICT ("shopId") DO UPDATE SET
           "slug" = COALESCE("StoryShop"."slug", EXCLUDED."slug"),
           "status" = CASE WHEN EXCLUDED."shopVersion" > "StoryShop"."shopVersion" AND $status::text IS NOT NULL
                           THEN $status::text ELSE "StoryShop"."status" END,
           "shopVersion" = GREATEST("StoryShop"."shopVersion", EXCLUDED."shopVersion")
         WHERE ("StoryShop"."slug" IS NULL AND EXCLUDED."slug" IS NOT NULL)
            OR EXCLUDED."shopVersion" > "StoryShop"."shopVersion"
         RETURNING 1`,
        { ...input },
      )) > 0
    );
  }

  async find(shopId: string): Promise<ShopCopy | null> {
    const row = await one<CopyRow>(
      this.db,
      `SELECT ${COLUMNS} FROM "StoryShop" WHERE "shopId" = $shopId`,
      { shopId },
    );
    return row && toCopy(row);
  }

  async findBySlug(slug: string): Promise<ShopCopy | null> {
    const row = await one<CopyRow>(
      this.db,
      `SELECT ${COLUMNS} FROM "StoryShop" WHERE "slug" = $slug AND "status" <> 'DELETED'`,
      { slug },
    );
    return row && toCopy(row);
  }

  /** One batch: up to `limit` stories of the shop with their drafts, versions and history, in the caller's transaction. */
  async purgeBatch(shopId: string, limit: number): Promise<string[]> {
    const stories = await rows<{ id: string; slug: string }>(
      this.db,
      `SELECT "id", "slug" FROM "Story" WHERE "shopId" = $shopId ORDER BY "id" LIMIT $limit`,
      { shopId, limit },
    );
    if (stories.length === 0) return [];
    const ids = stories.map((s) => s.id);
    const bind = { shopId, ids };
    await exec(
      this.db,
      `DELETE FROM "StoryTransition" WHERE "shopId" = $shopId AND "storyId" = ANY($ids::uuid[])`,
      bind,
    );
    await exec(
      this.db,
      `DELETE FROM "StoryVersion" WHERE "shopId" = $shopId AND "storyId" = ANY($ids::uuid[])`,
      bind,
    );
    await exec(
      this.db,
      `DELETE FROM "StoryDraft" WHERE "shopId" = $shopId AND "storyId" = ANY($ids::uuid[])`,
      bind,
    );
    await exec(
      this.db,
      `DELETE FROM "Story" WHERE "shopId" = $shopId AND "id" = ANY($ids::uuid[])`,
      bind,
    );
    return stories.map((s) => s.slug);
  }

  async deleteCopy(shopId: string): Promise<void> {
    await exec(this.db, `DELETE FROM "StoryShop" WHERE "shopId" = $shopId`, {
      shopId,
    });
  }
}
