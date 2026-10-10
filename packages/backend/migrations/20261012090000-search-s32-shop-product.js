'use strict';

/**
 * S32 discovery, expand step 1: "SearchShopProduct", the shop product search table fed by catalog.product_* events
 * (R3). No foreign keys: shopId and productId are plain columns (IX.4). Expand-only.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await t(`SET LOCAL lock_timeout = '3s'`);
      await t(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await t(`
        CREATE TABLE IF NOT EXISTS "SearchShopProduct" (
          "productId" UUID PRIMARY KEY,
          "shopId" UUID NOT NULL,
          "title" TEXT NOT NULL,
          "brand" TEXT NULL,
          "status" TEXT NOT NULL CHECK ("status" IN ('ACTIVE','ARCHIVED')),
          "priceMinor" BIGINT NOT NULL CHECK ("priceMinor" >= 0),
          "currency" CHAR(3) NOT NULL,
          "quantity" INTEGER NOT NULL,
          "isSandbox" BOOLEAN NOT NULL,
          "productVersion" BIGINT NOT NULL,
          "deletedAt" TIMESTAMPTZ NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL,
          "searchVector" TSVECTOR GENERATED ALWAYS AS (
            to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("brand", ''))
          ) STORED
        );
        CREATE INDEX IF NOT EXISTS "SearchShopProduct_searchVector_idx"
          ON "SearchShopProduct" USING GIN ("searchVector");
        CREATE INDEX IF NOT EXISTS "SearchShopProduct_title_trgm_idx"
          ON "SearchShopProduct" USING GIN (lower("title") gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS "SearchShopProduct_shop_status_idx"
          ON "SearchShopProduct" ("shopId", "status") WHERE "deletedAt" IS NULL;
        CREATE INDEX IF NOT EXISTS "SearchShopProduct_deletedAt_idx"
          ON "SearchShopProduct" ("deletedAt") WHERE "deletedAt" IS NOT NULL;
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP TABLE IF EXISTS "SearchShopProduct"`,
    );
  },
};
