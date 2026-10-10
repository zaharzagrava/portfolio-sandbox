'use strict';

/**
 * S10 orders, expand step 1 (III.11; reversible; additive for every legacy writer):
 *  - "BisOrder": requestHash, paymentRef; version defaults to 1 for new rows.
 *  - "BisOrderItem": title, discountMinor, lineTotalMinor (NULL until the backfill job has run).
 *  - "OrderEvent": actor, amountMinor.
 *  - "StockReservation": source accepts CATALOG (new default), sourceRef, releaseAttempts, nextReleaseAt; status gains
 *    REQUESTED and RELEASE_PENDING.
 *  - status checks on the three tables are added NOT VALID (the validate migration checks the old rows).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await t(`SET LOCAL lock_timeout = '3s'`);
      await t(`
        ALTER TABLE "BisOrder" ADD COLUMN IF NOT EXISTS "requestHash" TEXT NULL;
        ALTER TABLE "BisOrder" ADD COLUMN IF NOT EXISTS "paymentRef" TEXT NULL;
        ALTER TABLE "BisOrder" ALTER COLUMN "version" SET DEFAULT 1;

        ALTER TABLE "BisOrderItem" ADD COLUMN IF NOT EXISTS "title" TEXT NULL;
        ALTER TABLE "BisOrderItem" ADD COLUMN IF NOT EXISTS "discountMinor" BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE "BisOrderItem" ADD COLUMN IF NOT EXISTS "lineTotalMinor" BIGINT NULL;

        ALTER TABLE "OrderEvent" ADD COLUMN IF NOT EXISTS "actor" TEXT NULL;
        ALTER TABLE "OrderEvent" ADD COLUMN IF NOT EXISTS "amountMinor" BIGINT NULL;

        ALTER TABLE "StockReservation" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT NULL;
        ALTER TABLE "StockReservation" ADD COLUMN IF NOT EXISTS "releaseAttempts" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "StockReservation" ADD COLUMN IF NOT EXISTS "nextReleaseAt" TIMESTAMPTZ NULL;
        ALTER TABLE "StockReservation" ALTER COLUMN "source" SET DEFAULT 'CATALOG';
        ALTER TABLE "StockReservation" DROP CONSTRAINT IF EXISTS "StockReservation_source_check";
        ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_source_check"
          CHECK ("source" IN ('CATALOG','POSTGRES','FLASH')) NOT VALID;
        ALTER TABLE "StockReservation" DROP CONSTRAINT IF EXISTS "StockReservation_status_check";
        ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_status_check"
          CHECK ("status" IN ('REQUESTED','HELD','CONVERTED','RELEASE_PENDING','RELEASED')) NOT VALID;

        ALTER TABLE "BisOrder" DROP CONSTRAINT IF EXISTS "BisOrder_status_check";
        ALTER TABLE "BisOrder" ADD CONSTRAINT "BisOrder_status_check"
          CHECK ("status" IN ('PENDING','RESERVED','PAID','FULFILLING','SHIPPED','DELIVERED','CANCELLED','REFUNDED')) NOT VALID;
        ALTER TABLE "ShopOrder" DROP CONSTRAINT IF EXISTS "ShopOrder_status_check";
        ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_status_check"
          CHECK ("status" IN ('PENDING','PAID','CANCELLED','REFUNDED')) NOT VALID;
        ALTER TABLE "BisOrderItem" DROP CONSTRAINT IF EXISTS "BisOrderItem_lineTotal_check";
        ALTER TABLE "BisOrderItem" ADD CONSTRAINT "BisOrderItem_lineTotal_check"
          CHECK ("lineTotalMinor" IS NULL OR "lineTotalMinor" >= 0) NOT VALID;
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "BisOrderItem" DROP CONSTRAINT IF EXISTS "BisOrderItem_lineTotal_check";
      ALTER TABLE "ShopOrder" DROP CONSTRAINT IF EXISTS "ShopOrder_status_check";
      ALTER TABLE "BisOrder" DROP CONSTRAINT IF EXISTS "BisOrder_status_check";
      ALTER TABLE "StockReservation" DROP CONSTRAINT IF EXISTS "StockReservation_status_check";
      ALTER TABLE "StockReservation" DROP CONSTRAINT IF EXISTS "StockReservation_source_check";
      ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_source_check" CHECK ("source" IN ('POSTGRES','FLASH')) NOT VALID;
      ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_status_check" CHECK ("status" IN ('HELD','CONVERTED','RELEASED')) NOT VALID;
      ALTER TABLE "StockReservation" ALTER COLUMN "source" DROP DEFAULT;
      ALTER TABLE "StockReservation" DROP COLUMN IF EXISTS "nextReleaseAt", DROP COLUMN IF EXISTS "releaseAttempts", DROP COLUMN IF EXISTS "sourceRef";
      ALTER TABLE "OrderEvent" DROP COLUMN IF EXISTS "amountMinor", DROP COLUMN IF EXISTS "actor";
      ALTER TABLE "BisOrderItem" DROP COLUMN IF EXISTS "lineTotalMinor", DROP COLUMN IF EXISTS "discountMinor", DROP COLUMN IF EXISTS "title";
      ALTER TABLE "BisOrder" ALTER COLUMN "version" SET DEFAULT 0;
      ALTER TABLE "BisOrder" DROP COLUMN IF EXISTS "paymentRef", DROP COLUMN IF EXISTS "requestHash";
    `);
  },
};
