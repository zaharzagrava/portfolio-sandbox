'use strict';

/**
 * S47 knowledge documents, expand step (research.md R-5). Only adds: columns that are nullable, indexes, and CHECK
 * constraints added NOT VALID (validated by the backfill). Idempotent (`IF NOT EXISTS`, drop-then-add for constraints);
 * every statement runs under a 5 s `lock_timeout`, so a busy table makes the migration fail instead of queueing
 * readers behind it. The two foreign keys and the legacy `error` column go in the contract step (T061).
 */
const FAILURE_CODES = [
  'not_a_pdf',
  'unparseable',
  'no_text',
  'too_many_pages',
  'too_many_chunks',
  'size_mismatch',
  'embedding_unavailable',
]
  .map((c) => `'${c}'`)
  .join(', ');

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';

        ALTER TABLE "KnowledgeDocument"
          ADD COLUMN IF NOT EXISTS "failureCode" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "contentSize" BIGINT NULL,
          ADD COLUMN IF NOT EXISTS "leaseToken" UUID NULL,
          ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "queuedAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "bytesRemovedAt" TIMESTAMPTZ NULL;

        ALTER TABLE "KnowledgeDocument" DROP CONSTRAINT IF EXISTS "KnowledgeDocument_failureCode_check";
        ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_failureCode_check"
          CHECK ("failureCode" IS NULL OR "failureCode" IN (${FAILURE_CODES})) NOT VALID;

        ALTER TABLE "KnowledgeChunk"
          ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT NULL;

        ALTER TABLE "KnowledgeChunk" DROP CONSTRAINT IF EXISTS "KnowledgeChunk_tokens_check";
        ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_tokens_check"
          CHECK ("tokens" BETWEEN 1 AND 800) NOT VALID;

        CREATE INDEX IF NOT EXISTS "KnowledgeDocument_shop_list"
          ON "KnowledgeDocument" ("shopId", "createdAt" DESC, "id" DESC) WHERE "status" <> 'DELETED';
        CREATE INDEX IF NOT EXISTS "KnowledgeDocument_platform_list"
          ON "KnowledgeDocument" ("createdAt" DESC, "id" DESC) WHERE "shopId" IS NULL AND "status" <> 'DELETED';
        CREATE INDEX IF NOT EXISTS "KnowledgeDocument_sweep"
          ON "KnowledgeDocument" ("status", "queuedAt") WHERE "status" IN ('QUEUED', 'PROCESSING', 'AWAITING_UPLOAD');
        CREATE INDEX IF NOT EXISTS "KnowledgeDocument_tombstone"
          ON "KnowledgeDocument" ("deletedAt") WHERE "status" = 'DELETED';
        CREATE INDEX IF NOT EXISTS "KnowledgeDocument_product"
          ON "KnowledgeDocument" ("productId") WHERE "productId" IS NOT NULL AND "status" <> 'DELETED';
        `,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';
        DROP INDEX IF EXISTS "KnowledgeDocument_product", "KnowledgeDocument_tombstone", "KnowledgeDocument_sweep",
          "KnowledgeDocument_platform_list", "KnowledgeDocument_shop_list";
        ALTER TABLE "KnowledgeChunk" DROP CONSTRAINT IF EXISTS "KnowledgeChunk_tokens_check";
        ALTER TABLE "KnowledgeChunk" DROP COLUMN IF EXISTS "embeddingModel";
        ALTER TABLE "KnowledgeDocument" DROP CONSTRAINT IF EXISTS "KnowledgeDocument_failureCode_check";
        ALTER TABLE "KnowledgeDocument"
          DROP COLUMN IF EXISTS "bytesRemovedAt", DROP COLUMN IF EXISTS "deletedAt", DROP COLUMN IF EXISTS "queuedAt",
          DROP COLUMN IF EXISTS "leaseUntil", DROP COLUMN IF EXISTS "leaseToken", DROP COLUMN IF EXISTS "contentSize",
          DROP COLUMN IF EXISTS "failureCode";
        `,
        { transaction },
      );
    });
  },
};
