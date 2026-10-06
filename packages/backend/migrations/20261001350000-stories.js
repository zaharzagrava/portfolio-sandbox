'use strict';

/**
 * SD-05 brand stories. Drafts are edited per locale; publishing FREEZES all
 * locales into an immutable numbered version (rollback = republish an old
 * version; caches key on the version via ETag).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "Story" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "slug" TEXT NOT NULL CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
        "defaultLocale" TEXT NOT NULL DEFAULT 'en',
        "status" TEXT NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED')),
        "publishedVersion" INTEGER NULL,
        "scheduledAt" TIMESTAMPTZ NULL,
        "publishedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE ("shopId", "slug")
      );
      CREATE INDEX IF NOT EXISTS "Story_published_idx" ON "Story" ("id") WHERE status = 'PUBLISHED';

      CREATE TABLE IF NOT EXISTS "StoryDraft" (
        "storyId" UUID NOT NULL REFERENCES "Story"("id") ON DELETE CASCADE,
        "locale" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "blocks" JSONB NOT NULL,
        "seo" JSONB NOT NULL DEFAULT '{}',
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("storyId", "locale")
      );

      CREATE TABLE IF NOT EXISTS "StoryVersion" (
        "storyId" UUID NOT NULL REFERENCES "Story"("id") ON DELETE CASCADE,
        "version" INTEGER NOT NULL,
        "locale" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "blocks" JSONB NOT NULL,
        "seo" JSONB NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("storyId", "version", "locale")
      );
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "StoryVersion", "StoryDraft", "Story"`);
  },
};
