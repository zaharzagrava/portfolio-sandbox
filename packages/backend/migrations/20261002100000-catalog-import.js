'use strict';

/**
 * SD-27 bulk import/export. `externalSku` is the shop's own product id (from
 * its ERP): re-importing the same file upserts instead of duplicating. Jobs
 * carry checkpoints so a crashed worker resumes instead of starting over.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      SET lock_timeout = '5s';
      ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "externalSku" TEXT NULL;

      CREATE TABLE IF NOT EXISTS "ImportJob" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "createdBy" UUID NOT NULL REFERENCES "User"("id"),
        "status" TEXT NOT NULL DEFAULT 'PENDING_UPLOAD' CHECK ("status" IN ('PENDING_UPLOAD', 'UPLOADED', 'SCANNING', 'PROCESSING', 'DONE', 'FAILED')),
        "fileName" TEXT NOT NULL,
        "objectKey" TEXT NOT NULL UNIQUE,
        "uploadId" TEXT NULL,
        "sizeBytes" BIGINT NOT NULL,
        "rowsProcessed" INTEGER NOT NULL DEFAULT 0,
        "rowsFailed" INTEGER NOT NULL DEFAULT 0,
        "checkpointRow" INTEGER NOT NULL DEFAULT 0,
        "errorReportKey" TEXT NULL,
        "error" TEXT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "ImportJob_shop_idx" ON "ImportJob" ("shopId", "createdAt" DESC);

      CREATE TABLE IF NOT EXISTS "ExportJob" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "createdBy" UUID NOT NULL REFERENCES "User"("id"),
        "kind" TEXT NOT NULL CHECK ("kind" IN ('orders')),
        "status" TEXT NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED')),
        "objectKey" TEXT NULL,
        "rows" INTEGER NOT NULL DEFAULT 0,
        "error" TEXT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Product_shop_external_sku_uq" ON "Product" ("shopId", "externalSku") WHERE "externalSku" IS NOT NULL`,
    );
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "Product_shop_external_sku_uq";
      DROP TABLE IF EXISTS "ExportJob", "ImportJob";
      ALTER TABLE "Product" DROP COLUMN IF EXISTS "externalSku";
    `);
  },
};
