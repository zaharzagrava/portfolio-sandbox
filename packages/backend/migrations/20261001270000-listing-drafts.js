'use strict';

/**
 * SD-16 collaborative listing drafts. Postgres holds the draft record and the
 * pointer to the latest compacted snapshot (S3); the live update log is in
 * DynamoDB `DocUpdates` (append-heavy, read-by-key, deleted after compaction).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "ListingDraft" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "productId" UUID NULL REFERENCES "Product"("id"),
        "title" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
        "snapshotKey" TEXT NULL,
        "snapshotSeq" BIGINT NOT NULL DEFAULT 0,
        "createdBy" UUID NOT NULL REFERENCES "User"("id"),
        "publishedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "ListingDraft_shop_idx" ON "ListingDraft" ("shopId", "updatedAt" DESC);

      CREATE TABLE IF NOT EXISTS "ListingDraftVersion" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "draftId" UUID NOT NULL REFERENCES "ListingDraft"("id") ON DELETE CASCADE,
        "name" TEXT NOT NULL,
        "objectKey" TEXT NOT NULL,
        "createdBy" UUID NOT NULL REFERENCES "User"("id"),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "ListingDraftVersion_draft_idx" ON "ListingDraftVersion" ("draftId", "createdAt" DESC);
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "ListingDraftVersion", "ListingDraft"`);
  },
};
