'use strict';

/**
 * S11 flash sales, contract step: drops the legacy "price", tightens the status CHECK to the new set and makes
 * "shopId" NOT NULL. Run once no `flash-sale.start` job of the old shape is queued
 * (`SELECT count(*) FROM jobs WHERE type = 'flash-sale.start'` = 0). `down` recreates "price" from "priceMinor"; run it on a
 * throwaway database only.
 */

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';
        UPDATE "FlashSale" SET "status" = 'LOADED' WHERE "status" = 'LIVE';
        UPDATE "FlashSale" SET "status" = 'CANCELLED', "statusReason" = 'cancelled_by_shop' WHERE "shopId" IS NULL AND "status" = 'SCHEDULED';
        ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_status_check";
        ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_status_check"
          CHECK ("status" IN ('SCHEDULED','LOADED','ENDED','RECONCILED','CANCELLED','START_FAILED'));
        ALTER TABLE "FlashSale" DROP COLUMN IF EXISTS "price";
        `,
        { transaction },
      );
      // Terminal legacy rows may keep a NULL shop (no way to derive it without reading Product): they get the nil uuid.
      await sequelize.query(
        `
        UPDATE "FlashSale" SET "shopId" = '00000000-0000-0000-0000-000000000000' WHERE "shopId" IS NULL;
        ALTER TABLE "FlashSale" ALTER COLUMN "shopId" SET NOT NULL;
        `,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "FlashSale" ALTER COLUMN "shopId" DROP NOT NULL;
      ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_status_check";
      ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_status_check"
        CHECK ("status" IN ('SCHEDULED','LIVE','LOADED','ENDED','RECONCILED','CANCELLED','START_FAILED'));
      ALTER TABLE "FlashSale" ADD COLUMN IF NOT EXISTS "price" BIGINT NULL;
      UPDATE "FlashSale" SET "price" = "priceMinor" WHERE "price" IS NULL;
      ALTER TABLE "FlashSale" ALTER COLUMN "price" SET NOT NULL;
    `);
  },
};
