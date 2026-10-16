'use strict';

/**
 * S27 brand stories, expand step (III.11; specs/domains/S27-brand-stories/data-model.md). Additive and idempotent; the
 * history of `20261001350000-stories.js` stays untouched. Every group runs in its own short transaction with
 * `SET LOCAL lock_timeout`; indexes are built outside any transaction, `CONCURRENTLY`, after the backfill.
 *
 *  - "Story": scheduledBy, scheduleFailure, sitemapPosition (from `story_sitemap_position_seq`); the foreign key to
 *    "Shop" is dropped (IX.4: the shop is another domain's table, the id stays a plain column).
 *  - "StoryDraft": shopId (carried for every predicate and for the shop purge), revision (existing drafts are revision 1).
 *  - "StoryVersion": shopId, publishedAt, publishedBy.
 *  - "StoryTransition" (history) and "StoryShop" (the copy of the shop's slug and status, R3), backfilled once from
 *    "Shop" for the shops that already have stories; the event consumer keeps it afterwards.
 *
 * `SCHEDULED` leaves the status check in the contract step (`...-stories-s27-contract.js`), once no code writes it.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

const GROUPS = [
  [
    `ALTER TABLE "Story"
       ADD COLUMN IF NOT EXISTS "scheduledBy" UUID NULL,
       ADD COLUMN IF NOT EXISTS "scheduleFailure" JSONB NULL,
       ADD COLUMN IF NOT EXISTS "sitemapPosition" BIGINT NULL`,
    `CREATE SEQUENCE IF NOT EXISTS story_sitemap_position_seq AS BIGINT START 1`,
    `ALTER TABLE "Story" DROP CONSTRAINT IF EXISTS "Story_shopId_fkey"`,
  ],
  [
    `ALTER TABLE "StoryDraft"
       ADD COLUMN IF NOT EXISTS "shopId" UUID NULL,
       ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0`,
    `UPDATE "StoryDraft" d SET "shopId" = s."shopId" FROM "Story" s WHERE s."id" = d."storyId" AND d."shopId" IS NULL`,
    `UPDATE "StoryDraft" SET "revision" = 1 WHERE "revision" = 0`,
    `ALTER TABLE "StoryDraft" ALTER COLUMN "shopId" SET NOT NULL`,
    `ALTER TABLE "StoryDraft" DROP CONSTRAINT IF EXISTS "StoryDraft_revision_check"`,
    `ALTER TABLE "StoryDraft" ADD CONSTRAINT "StoryDraft_revision_check" CHECK ("revision" >= 0)`,
  ],
  [
    `ALTER TABLE "StoryVersion"
       ADD COLUMN IF NOT EXISTS "shopId" UUID NULL,
       ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "publishedBy" UUID NULL`,
    `UPDATE "StoryVersion" v SET "shopId" = s."shopId" FROM "Story" s WHERE s."id" = v."storyId" AND v."shopId" IS NULL`,
    `UPDATE "StoryVersion" SET "publishedAt" = "createdAt" WHERE "publishedAt" IS NULL`,
    `ALTER TABLE "StoryVersion" ALTER COLUMN "shopId" SET NOT NULL`,
    `ALTER TABLE "StoryVersion" ALTER COLUMN "publishedAt" SET NOT NULL`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS "StoryTransition" (
       "id" UUID PRIMARY KEY DEFAULT uuidv7(),
       "shopId" UUID NOT NULL,
       "storyId" UUID NOT NULL,
       "from" TEXT NULL,
       "to" TEXT NOT NULL,
       "action" TEXT NOT NULL CHECK ("action" IN ('create', 'publish', 'schedule', 'cancel_schedule', 'fire', 'fire_failed', 'archive')),
       "actor" UUID NULL,
       "occurredAt" TIMESTAMPTZ NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS "StoryShop" (
       "shopId" UUID PRIMARY KEY,
       "slug" TEXT NULL,
       "status" TEXT NOT NULL CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED')),
       "shopVersion" BIGINT NOT NULL
     )`,
  ],
  [
    // The one-time copy of the shops that already have stories; after this the consumer owns the table.
    `INSERT INTO "StoryShop" ("shopId", "slug", "status", "shopVersion")
       SELECT sh."id", sh."slug", sh."status", sh."shopVersion" FROM "Shop" sh
        WHERE EXISTS (SELECT 1 FROM "Story" t WHERE t."shopId" = sh."id")
       ON CONFLICT ("shopId") DO NOTHING`,
    // Positions for the stories that were already published, in id order (never reused afterwards).
    `UPDATE "Story" s SET "sitemapPosition" = ordered."position"
       FROM (SELECT "id", nextval('story_sitemap_position_seq') AS "position"
               FROM (SELECT "id" FROM "Story" WHERE "publishedVersion" IS NOT NULL AND "sitemapPosition" IS NULL ORDER BY "id") q) ordered
      WHERE s."id" = ordered."id"`,
  ],
];

const INDEXES = [
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Story_sitemapPosition_key" ON "Story" ("sitemapPosition") WHERE "sitemapPosition" IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Story_published_position_idx" ON "Story" ("sitemapPosition") WHERE "status" = 'PUBLISHED'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Story_shop_list_idx" ON "Story" ("shopId", "createdAt" DESC, "id" DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Story_due_idx" ON "Story" ("scheduledAt", "id") WHERE "scheduledAt" IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "StoryDraft_shop_story_idx" ON "StoryDraft" ("shopId", "storyId")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "StoryVersion_shop_story_idx" ON "StoryVersion" ("shopId", "storyId", "version" DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "StoryTransition_story_idx" ON "StoryTransition" ("shopId", "storyId", "occurredAt")`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "StoryShop_slug_key" ON "StoryShop" ("slug") WHERE "status" <> 'DELETED'`,
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const group of GROUPS) {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(LOCK_TIMEOUT, { transaction });
        for (const sql of group) await sequelize.query(sql, { transaction });
      });
    }
    for (const sql of INDEXES) await sequelize.query(sql);
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(LOCK_TIMEOUT);
      await q(`DROP TABLE IF EXISTS "StoryShop", "StoryTransition"`);
      await q(`ALTER TABLE "StoryVersion" DROP COLUMN IF EXISTS "publishedBy", DROP COLUMN IF EXISTS "publishedAt", DROP COLUMN IF EXISTS "shopId"`);
      await q(`ALTER TABLE "StoryDraft" DROP COLUMN IF EXISTS "revision", DROP COLUMN IF EXISTS "shopId"`);
      await q(`ALTER TABLE "Story" DROP COLUMN IF EXISTS "sitemapPosition", DROP COLUMN IF EXISTS "scheduleFailure", DROP COLUMN IF EXISTS "scheduledBy"`);
      await q(`DROP SEQUENCE IF EXISTS story_sitemap_position_seq`);
    });
  },
};
