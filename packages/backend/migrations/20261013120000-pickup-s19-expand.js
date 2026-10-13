'use strict';

/**
 * S19 pickup, expand step (III.11, never run at application start): the point `version` (the `pointVersion` of
 * `pickup.point_changed`), the upper stock bound as a store-level CHECK, the seller-list keyset index, and the two
 * copy tables that replace every read of another domain's tables (`PickupProductCopy` from `catalog.product_*`,
 * `PickupShopCopy` from `tenancy.shop_*`). The foreign keys to `Shop` and `Product` go in the separate contract step.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(
        `ALTER TABLE "PickupPoint" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1`,
      );
      // New rows only see the bound at once; the existing ones are validated in the same step (the table is small
      // before the capability goes live; a populated table would split NOT VALID and VALIDATE into two releases).
      await q(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PickupStock_quantity_max') THEN
            ALTER TABLE "PickupStock" ADD CONSTRAINT "PickupStock_quantity_max" CHECK ("quantity" <= 1000000) NOT VALID;
          END IF;
        END $$;
      `);
      await q(`ALTER TABLE "PickupStock" VALIDATE CONSTRAINT "PickupStock_quantity_max"`);
      await q(
        `CREATE INDEX IF NOT EXISTS "PickupPoint_shop_keyset_idx" ON "PickupPoint" ("shopId", "createdAt", "id")`,
      );
      await q(`DROP INDEX IF EXISTS "PickupPoint_shop_idx"`);
      await q(`
        CREATE TABLE IF NOT EXISTS "PickupProductCopy" (
          "productId" UUID PRIMARY KEY,
          "shopId" UUID NOT NULL,
          "title" TEXT NOT NULL,
          "category" TEXT NOT NULL,
          "priceMinor" BIGINT NOT NULL,
          "currency" CHAR(3) NOT NULL,
          "status" TEXT NOT NULL CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
          "isSandbox" BOOLEAN NOT NULL,
          "version" BIGINT NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "PickupProductCopy_shop_idx" ON "PickupProductCopy" ("shopId");

        CREATE TABLE IF NOT EXISTS "PickupShopCopy" (
          "shopId" UUID PRIMARY KEY,
          "status" TEXT NOT NULL,
          "version" BIGINT NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS "PickupShopCopy", "PickupProductCopy";
      CREATE INDEX IF NOT EXISTS "PickupPoint_shop_idx" ON "PickupPoint" ("shopId");
      DROP INDEX IF EXISTS "PickupPoint_shop_keyset_idx";
      ALTER TABLE "PickupStock" DROP CONSTRAINT IF EXISTS "PickupStock_quantity_max";
      ALTER TABLE "PickupPoint" DROP COLUMN IF EXISTS "version";
    `);
  },
};
