'use strict';

/**
 * S11 flash sales, expand step (data-model §1). Reshapes "FlashSale" (priceMinor, admissionRatePerSecond, currency,
 * statusReason, version, endedAt, reconciledAt), widens the status CHECK to old ∪ new, rewrites LIVE → LOADED, cancels
 * legacy SCHEDULED rows that cannot be kept (no shop, or overlapping another non-terminal sale of the same product),
 * creates the append-only "FlashSaleHistory", the indexes, the overlap EXCLUDE constraint and the flash claim rules on
 * "StockReservation". The contract step (20261014110100) drops "price". Idempotent; every statement runs under a 5 s
 * lock_timeout. `down` is for a throwaway database only.
 */

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';
        CREATE EXTENSION IF NOT EXISTS btree_gist;

        CREATE TABLE IF NOT EXISTS "FlashSaleHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "saleId" UUID NOT NULL,
          "fromStatus" TEXT NULL,
          "toStatus" TEXT NOT NULL,
          "reason" TEXT NULL,
          "actor" TEXT NOT NULL,
          "at" TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "FlashSaleHistory_sale_at_idx" ON "FlashSaleHistory" ("saleId", "at");

        ALTER TABLE "FlashSale" ADD COLUMN IF NOT EXISTS "priceMinor" BIGINT NULL;
        ALTER TABLE "FlashSale" ADD COLUMN IF NOT EXISTS "admissionRatePerSecond" INTEGER NOT NULL DEFAULT 2000;
        ALTER TABLE "FlashSale" ADD COLUMN IF NOT EXISTS "currency" TEXT NULL;
        ALTER TABLE "FlashSale" ADD COLUMN IF NOT EXISTS "statusReason" TEXT NULL;
        ALTER TABLE "FlashSale" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "FlashSale" ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMPTZ NULL;
        ALTER TABLE "FlashSale" ADD COLUMN IF NOT EXISTS "reconciledAt" TIMESTAMPTZ NULL;

        -- the legacy "price" column is dropped by the contract step; until then it must not block new inserts
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'FlashSale' AND column_name = 'price') THEN
            ALTER TABLE "FlashSale" ALTER COLUMN "price" DROP NOT NULL;
            UPDATE "FlashSale" SET "priceMinor" = "price" WHERE "priceMinor" IS NULL;
          END IF;
        END $$;

        -- one-off data fix: the sale currency is the product currency at scheduling (migration-only read of "Product")
        UPDATE "FlashSale" f SET "currency" = p."currency" FROM "Product" p WHERE p."id" = f."productId" AND f."currency" IS NULL;
        UPDATE "FlashSale" SET "currency" = 'USD' WHERE "currency" IS NULL;

        ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_status_check";
        ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_status_check"
          CHECK ("status" IN ('SCHEDULED','LIVE','LOADED','ENDED','RECONCILED','CANCELLED','START_FAILED'));
        UPDATE "FlashSale" SET "status" = 'LOADED' WHERE "status" = 'LIVE';

        -- legacy SCHEDULED rows without a shop, or overlapping an earlier non-terminal sale of the product, are cancelled
        WITH doomed AS (
          UPDATE "FlashSale" f SET "status" = 'CANCELLED', "statusReason" = 'cancelled_by_shop', "version" = "version" + 1, "updatedAt" = now()
          WHERE f."status" = 'SCHEDULED' AND (
            f."shopId" IS NULL OR EXISTS (
              SELECT 1 FROM "FlashSale" o
              WHERE o."productId" = f."productId" AND o."id" <> f."id" AND o."status" IN ('SCHEDULED','LOADED','ENDED')
                AND tstzrange(o."startsAt", o."endsAt", '[)') && tstzrange(f."startsAt", f."endsAt", '[)')
                AND (o."status" <> 'SCHEDULED' OR (o."startsAt", o."id") < (f."startsAt", f."id"))
            )
          )
          RETURNING f."id"
        )
        INSERT INTO "FlashSaleHistory" ("saleId", "fromStatus", "toStatus", "reason", "actor", "at")
        SELECT "id", 'SCHEDULED', 'CANCELLED', 'cancelled_by_shop', 'system:migration', now() FROM doomed;

        ALTER TABLE "FlashSale" ALTER COLUMN "priceMinor" SET NOT NULL;
        ALTER TABLE "FlashSale" ALTER COLUMN "currency" SET NOT NULL;

        ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_priceMinor_check";
        ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_priceMinor_check" CHECK ("priceMinor" > 0);
        ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_currency_check";
        ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$') NOT VALID;
        ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_admission_check";
        ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_admission_check" CHECK ("admissionRatePerSecond" BETWEEN 1 AND 10000);
        ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_reason_check";
        ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_reason_check"
          CHECK ("statusReason" IS NULL OR "statusReason" IN ('insufficient_stock','window_missed','cancelled_by_shop','product_unavailable'));
        ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_units_check";
        ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_units_check" CHECK ("units" BETWEEN 1 AND 1000000) NOT VALID;
        ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_per_user_check";
        ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_per_user_check"
          CHECK ("perUserLimit" BETWEEN 1 AND 20 AND "perUserLimit" <= "units") NOT VALID;
        ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_window_check";
        ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_window_check"
          CHECK ("endsAt" > "startsAt" AND "endsAt" - "startsAt" <= interval '24 hours') NOT VALID;

        CREATE INDEX IF NOT EXISTS "FlashSale_shop_page_idx" ON "FlashSale" ("shopId", "startsAt" DESC, "id" DESC);
        CREATE INDEX IF NOT EXISTS "FlashSale_loaded_idx" ON "FlashSale" ("endsAt") WHERE "status" = 'LOADED';

        ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_no_overlap";
        ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_no_overlap"
          EXCLUDE USING gist ("productId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&)
          WHERE ("status" IN ('SCHEDULED','LOADED','ENDED'));

        CREATE INDEX IF NOT EXISTS "StockReservation_flash_sale_idx" ON "StockReservation" ("flashSaleId", "status") WHERE "source" = 'FLASH';
        CREATE UNIQUE INDEX IF NOT EXISTS "StockReservation_flash_claim_uq" ON "StockReservation" ("sourceRef") WHERE "source" = 'FLASH';
        ALTER TABLE "StockReservation" DROP CONSTRAINT IF EXISTS "StockReservation_flash_check";
        ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_flash_check"
          CHECK ("source" <> 'FLASH' OR ("flashSaleId" IS NOT NULL AND "sourceRef" IS NOT NULL)) NOT VALID;
        `,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "StockReservation" DROP CONSTRAINT IF EXISTS "StockReservation_flash_check";
      DROP INDEX IF EXISTS "StockReservation_flash_claim_uq";
      DROP INDEX IF EXISTS "StockReservation_flash_sale_idx";
      ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_no_overlap";
      DROP INDEX IF EXISTS "FlashSale_loaded_idx";
      DROP INDEX IF EXISTS "FlashSale_shop_page_idx";
      ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_window_check", DROP CONSTRAINT IF EXISTS "FlashSale_per_user_check",
        DROP CONSTRAINT IF EXISTS "FlashSale_units_check", DROP CONSTRAINT IF EXISTS "FlashSale_reason_check",
        DROP CONSTRAINT IF EXISTS "FlashSale_admission_check", DROP CONSTRAINT IF EXISTS "FlashSale_currency_check",
        DROP CONSTRAINT IF EXISTS "FlashSale_priceMinor_check";
      UPDATE "FlashSale" SET "status" = 'LIVE' WHERE "status" = 'LOADED';
      UPDATE "FlashSale" SET "status" = 'RECONCILED' WHERE "status" IN ('CANCELLED','START_FAILED');
      ALTER TABLE "FlashSale" DROP CONSTRAINT IF EXISTS "FlashSale_status_check";
      ALTER TABLE "FlashSale" ADD CONSTRAINT "FlashSale_status_check" CHECK ("status" IN ('SCHEDULED','LIVE','ENDED','RECONCILED'));
      ALTER TABLE "FlashSale" DROP COLUMN IF EXISTS "reconciledAt", DROP COLUMN IF EXISTS "endedAt", DROP COLUMN IF EXISTS "version",
        DROP COLUMN IF EXISTS "statusReason", DROP COLUMN IF EXISTS "currency", DROP COLUMN IF EXISTS "admissionRatePerSecond",
        DROP COLUMN IF EXISTS "priceMinor";
      DROP TABLE IF EXISTS "FlashSaleHistory";
    `);
  },
};
