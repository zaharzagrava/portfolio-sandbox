'use strict';

/**
 * S42 expand (specs/domains/S42-public-api/data-model.md section 4, step 1). Additive only: nothing the running code
 * reads changes shape. Every statement runs under `lock_timeout = '3s'`; each one is idempotent.
 *
 *  - `ApiKey.successorId`, `ApiKey.rotatedAt`, `ApiKey.hashVersion` (1 = current pepper, 0 = previous)
 *  - `ShopApiSettings.pinnedAt` (backfilled from `updatedAt`)
 *  - `ApiBulkJob`, `ApiBulkChunk`, `ApiUsageBucket`
 *  - indexes: unique `(prefix)` (already a constraint), list `(shopId, createdAt DESC, id)`, limit count partial
 *    `(shopId) WHERE revokedAt IS NULL`
 *
 * `down` is meant for a throwaway database only.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);

      await q(`
        ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "successorId" UUID NULL;
        ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "rotatedAt" TIMESTAMPTZ NULL;
        ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "hashVersion" SMALLINT NOT NULL DEFAULT 1;
        CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_prefix_uq" ON "ApiKey" ("prefix");
        CREATE INDEX IF NOT EXISTS "ApiKey_shop_list_idx" ON "ApiKey" ("shopId", "createdAt" DESC, "id");
        CREATE INDEX IF NOT EXISTS "ApiKey_shop_live_idx" ON "ApiKey" ("shopId") WHERE "revokedAt" IS NULL;

        ALTER TABLE "ShopApiSettings" ADD COLUMN IF NOT EXISTS "pinnedAt" TIMESTAMPTZ NULL;
        UPDATE "ShopApiSettings" SET "pinnedAt" = "updatedAt" WHERE "pinnedAt" IS NULL;

        CREATE TABLE IF NOT EXISTS "ApiBulkJob" (
          "id" VARCHAR(36) PRIMARY KEY CHECK ("id" ~ '^bsu_[0-9a-f]{32}$'),
          "shopId" UUID NOT NULL,
          "total" INTEGER NOT NULL CHECK ("total" BETWEEN 101 AND 10000),
          "chunks" INTEGER NOT NULL CHECK ("chunks" >= 2),
          "completedChunks" INTEGER NOT NULL DEFAULT 0,
          "applied" INTEGER NOT NULL DEFAULT 0,
          "replayed" INTEGER NOT NULL DEFAULT 0,
          "failed" INTEGER NOT NULL DEFAULT 0,
          "failures" JSONB NOT NULL DEFAULT '[]',
          "status" VARCHAR(20) NOT NULL DEFAULT 'processing'
            CHECK ("status" IN ('processing', 'succeeded', 'partially_failed', 'failed')),
          "createdAt" TIMESTAMPTZ NOT NULL,
          "expiresAt" TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "ApiBulkJob_shop_idx" ON "ApiBulkJob" ("shopId", "id");
        CREATE INDEX IF NOT EXISTS "ApiBulkJob_expires_idx" ON "ApiBulkJob" ("expiresAt");

        CREATE TABLE IF NOT EXISTS "ApiBulkChunk" (
          "jobId" VARCHAR(36) NOT NULL,
          "index" INTEGER NOT NULL,
          "shopId" UUID NOT NULL,
          "state" VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending', 'done', 'failed')),
          "result" JSONB NULL,
          "completedAt" TIMESTAMPTZ NULL,
          PRIMARY KEY ("jobId", "index")
        );

        CREATE TABLE IF NOT EXISTS "ApiUsageBucket" (
          "shopId" UUID NOT NULL,
          "minute" TIMESTAMPTZ NOT NULL,
          "sequence" INTEGER NOT NULL,
          "quantity" INTEGER NOT NULL CHECK ("quantity" >= 1),
          "emittedAt" TIMESTAMPTZ NULL,
          "eventId" UUID NULL,
          PRIMARY KEY ("shopId", "minute", "sequence")
        );
        CREATE INDEX IF NOT EXISTS "ApiUsageBucket_open_idx" ON "ApiUsageBucket" ("emittedAt") WHERE "emittedAt" IS NULL;
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS "ApiUsageBucket", "ApiBulkChunk", "ApiBulkJob";
      DROP INDEX IF EXISTS "ApiKey_shop_live_idx";
      DROP INDEX IF EXISTS "ApiKey_shop_list_idx";
      DROP INDEX IF EXISTS "ApiKey_prefix_uq";
      ALTER TABLE "ShopApiSettings" DROP COLUMN IF EXISTS "pinnedAt";
      ALTER TABLE "ApiKey" DROP COLUMN IF EXISTS "hashVersion";
      ALTER TABLE "ApiKey" DROP COLUMN IF EXISTS "rotatedAt";
      ALTER TABLE "ApiKey" DROP COLUMN IF EXISTS "successorId";
    `);
  },
};
