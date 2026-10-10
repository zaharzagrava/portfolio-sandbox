'use strict';

/**
 * S05 catalog, expand step 2: the four tables the capability owns besides "Product" (data-model.md). Plain id columns,
 * no foreign key to any table (IX.4); the product purge deletes children and parent in one transaction.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        CREATE TABLE IF NOT EXISTS "ProductStatusHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "productId" UUID NOT NULL,
          "shopId" UUID NOT NULL,
          "fromStatus" VARCHAR(16) NOT NULL,
          "toStatus" VARCHAR(16) NOT NULL,
          "productVersion" INTEGER NOT NULL,
          "actorId" UUID NULL,
          "at" TIMESTAMPTZ NOT NULL,
          CONSTRAINT "ProductStatusHistory_pair_check" CHECK (
            ("fromStatus" = 'ACTIVE' AND "toStatus" = 'ARCHIVED') OR ("fromStatus" = 'ARCHIVED' AND "toStatus" = 'ACTIVE'))
        );
        CREATE INDEX IF NOT EXISTS "ProductStatusHistory_product_at_idx" ON "ProductStatusHistory" ("productId", "at");
        CREATE INDEX IF NOT EXISTS "ProductStatusHistory_shop_idx" ON "ProductStatusHistory" ("shopId");

        CREATE TABLE IF NOT EXISTS "ProductStockOperation" (
          "operationId" VARCHAR(128) PRIMARY KEY,
          "productId" UUID NOT NULL,
          "shopId" UUID NOT NULL,
          "delta" INTEGER NOT NULL,
          "reason" VARCHAR(64) NOT NULL,
          "quantityAfter" INTEGER NOT NULL,
          "productVersion" INTEGER NOT NULL,
          "appliedAt" TIMESTAMPTZ NOT NULL,
          CONSTRAINT "ProductStockOperation_delta_check" CHECK ("delta" <> 0 AND abs("delta") <= 1000000),
          CONSTRAINT "ProductStockOperation_reason_check" CHECK ("reason" ~ '^[a-z0-9._-]{1,64}$')
        );
        CREATE INDEX IF NOT EXISTS "ProductStockOperation_applied_idx" ON "ProductStockOperation" ("appliedAt");
        CREATE INDEX IF NOT EXISTS "ProductStockOperation_shop_idx" ON "ProductStockOperation" ("shopId");

        CREATE TABLE IF NOT EXISTS "ProductShopState" (
          "shopId" UUID PRIMARY KEY,
          "status" VARCHAR(16) NOT NULL,
          "shopVersion" INTEGER NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL,
          CONSTRAINT "ProductShopState_status_check" CHECK ("status" IN ('ACTIVE','SUSPENDED','DELETING','DELETED'))
        );

        CREATE TABLE IF NOT EXISTS "ProductViewBatch" (
          "batchId" UUID NOT NULL,
          "chunk" INTEGER NOT NULL,
          "appliedAt" TIMESTAMPTZ NOT NULL,
          PRIMARY KEY ("batchId", "chunk")
        );
        CREATE INDEX IF NOT EXISTS "ProductViewBatch_applied_idx" ON "ProductViewBatch" ("appliedAt");
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        DROP TABLE IF EXISTS "ProductViewBatch";
        DROP TABLE IF EXISTS "ProductShopState";
        DROP TABLE IF EXISTS "ProductStockOperation";
        DROP TABLE IF EXISTS "ProductStatusHistory";
      `);
    });
  },
};
