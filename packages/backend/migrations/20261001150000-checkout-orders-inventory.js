'use strict';

/**
 * SD-19 checkout & inventory. BisOrder (existing, referenced by Payment) becomes
 * the checkout order aggregate: status state machine, server-computed total,
 * idempotency key, reservation expiry, OCC version. Additive columns only
 * (constant defaults → metadata-only in PG 11+, no rewrite).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '5s'`);
      await q(`
        ALTER TABLE "BisOrder" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PENDING';
        ALTER TABLE "BisOrder" ADD COLUMN IF NOT EXISTS "total" BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE "BisOrder" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'EUR';
        ALTER TABLE "BisOrder" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT NULL;
        ALTER TABLE "BisOrder" ADD COLUMN IF NOT EXISTS "reservedUntil" TIMESTAMPTZ NULL;
        ALTER TABLE "BisOrder" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "BisOrder" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT NULL;

        ALTER TABLE "BisOrderItem" ADD COLUMN IF NOT EXISTS "shopId" UUID NULL;
        ALTER TABLE "BisOrderItem" ADD COLUMN IF NOT EXISTS "flashSaleId" UUID NULL;

        -- Per-shop slice of a multi-seller order: each shop fulfils (and is paid) independently.
        CREATE TABLE IF NOT EXISTS "ShopOrder" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "bisOrderId" UUID NOT NULL REFERENCES "BisOrder"("id") ON DELETE CASCADE,
          "shopId" UUID NULL,
          "subtotal" BIGINT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'PENDING',
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE ("bisOrderId", "shopId")
        );
        CREATE INDEX IF NOT EXISTS "ShopOrder_shop_idx" ON "ShopOrder" ("shopId", "createdAt" DESC);

        -- Append-only transition history (audit + debugging + timeline UI).
        CREATE TABLE IF NOT EXISTS "OrderEvent" (
          "id" BIGSERIAL PRIMARY KEY,
          "bisOrderId" UUID NOT NULL REFERENCES "BisOrder"("id") ON DELETE CASCADE,
          "fromStatus" TEXT NULL,
          "toStatus" TEXT NOT NULL,
          "reason" TEXT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "OrderEvent_order_idx" ON "OrderEvent" ("bisOrderId", "id");

        CREATE TABLE IF NOT EXISTS "StockReservation" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "bisOrderId" UUID NOT NULL REFERENCES "BisOrder"("id") ON DELETE CASCADE,
          "productId" UUID NOT NULL,
          "quantity" INTEGER NOT NULL CHECK ("quantity" > 0),
          "source" TEXT NOT NULL CHECK ("source" IN ('POSTGRES','FLASH')),
          "flashSaleId" UUID NULL,
          "bucket" INTEGER NULL,
          "status" TEXT NOT NULL DEFAULT 'HELD' CHECK ("status" IN ('HELD','CONVERTED','RELEASED')),
          "expiresAt" TIMESTAMPTZ NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "StockReservation_order_idx" ON "StockReservation" ("bisOrderId");
        CREATE INDEX IF NOT EXISTS "StockReservation_held_expiry_idx" ON "StockReservation" ("expiresAt") WHERE "status" = 'HELD';

        CREATE TABLE IF NOT EXISTS "FlashSale" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "productId" UUID NOT NULL,
          "shopId" UUID NULL,
          "price" BIGINT NOT NULL,
          "units" INTEGER NOT NULL CHECK ("units" > 0),
          "buckets" INTEGER NOT NULL DEFAULT 16 CHECK ("buckets" BETWEEN 1 AND 256),
          "perUserLimit" INTEGER NOT NULL DEFAULT 2,
          "startsAt" TIMESTAMPTZ NOT NULL,
          "endsAt" TIMESTAMPTZ NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK ("status" IN ('SCHEDULED','LIVE','ENDED','RECONCILED')),
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK ("endsAt" > "startsAt")
        );
        CREATE INDEX IF NOT EXISTS "FlashSale_product_idx" ON "FlashSale" ("productId", "startsAt");

        -- Inbox: provider webhook events processed exactly once (Stripe retries, replays).
        CREATE TABLE IF NOT EXISTS "ProcessedWebhookEvent" (
          "provider" TEXT NOT NULL,
          "eventId" TEXT NOT NULL,
          "processedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("provider", "eventId")
        );
      `);
    });

    // Idempotent checkout: one order per (user, Idempotency-Key). Partial: legacy orders have no key.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "BisOrder_user_idem_key" ON "BisOrder" ("userId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    );
    // Order history page: covering index → index-only scans for the list (lesson 03/01 §3.2).
    await queryInterface.sequelize.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "BisOrder_user_history_idx" ON "BisOrder" ("userId", "createdAt" DESC) INCLUDE ("status", "total")`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "BisOrder_user_history_idx";
      DROP INDEX IF EXISTS "BisOrder_user_idem_key";
      DROP TABLE IF EXISTS "ProcessedWebhookEvent", "FlashSale", "StockReservation", "OrderEvent", "ShopOrder";
      ALTER TABLE "BisOrderItem" DROP COLUMN IF EXISTS "flashSaleId", DROP COLUMN IF EXISTS "shopId";
      ALTER TABLE "BisOrder" DROP COLUMN IF EXISTS "cancelReason", DROP COLUMN IF EXISTS "version", DROP COLUMN IF EXISTS "reservedUntil",
        DROP COLUMN IF EXISTS "idempotencyKey", DROP COLUMN IF EXISTS "currency", DROP COLUMN IF EXISTS "total", DROP COLUMN IF EXISTS "status";
    `);
  },
};
