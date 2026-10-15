'use strict';

/**
 * S09 expand (specs/domains/S09-offline-sync/data-model.md, research R-16). Additive and repeatable: every statement
 * runs under `lock_timeout = '3s'`, the unique index is built CONCURRENTLY outside the transaction.
 *
 *  - `SyncOperation`: the key becomes `(shopId, opId)` (unique index here, primary key in the contract step), content
 *    fingerprint, stored content, user, status, result numbers and claim time; the legacy `result` / `appliedAt` stay
 *    until the contract step (`result` loses NOT NULL so new rows need not write it).
 *  - new `SyncConflict`
 *  - `ShopChangeLog`: version, tombstone flag; `data` nullable. `ShopSyncState`: generation (0 = feed not built by the
 *    projector yet), compaction horizon.
 *  - `ProductFieldClock`: `shopId` (read once from the product table, the data step of this migration; a clock whose
 *    shop cannot be found is deleted: the next edit rebuilds it), `price` renamed `priceMinor`, primary key
 *    `(shopId, productId, field)`. The foreign key to the product table goes in the contract step.
 *
 * `down` is meant for a throwaway database only.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);

      // ---- SyncOperation ----------------------------------------------------------------------------------------
      await q(`
        ALTER TABLE "SyncOperation" ALTER COLUMN "result" DROP NOT NULL;
        ALTER TABLE "SyncOperation" ADD COLUMN IF NOT EXISTS "productId" UUID NULL;
        ALTER TABLE "SyncOperation" ADD COLUMN IF NOT EXISTS "userId" UUID NULL;
        ALTER TABLE "SyncOperation" ADD COLUMN IF NOT EXISTS "fingerprint" CHAR(64) NULL;
        ALTER TABLE "SyncOperation" ADD COLUMN IF NOT EXISTS "content" JSONB NULL;
        ALTER TABLE "SyncOperation" ADD COLUMN IF NOT EXISTS "status" TEXT NULL;
        ALTER TABLE "SyncOperation" ADD COLUMN IF NOT EXISTS "code" TEXT NULL;
        ALTER TABLE "SyncOperation" ADD COLUMN IF NOT EXISTS "quantityAfter" INTEGER NULL;
        ALTER TABLE "SyncOperation" ADD COLUMN IF NOT EXISTS "productVersion" INTEGER NULL;
        ALTER TABLE "SyncOperation" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMPTZ NULL;
        ALTER TABLE "SyncOperation" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMPTZ NULL;
        ALTER TABLE "SyncOperation" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now();
      `);
      // Legacy rows keep their outcome: the status is what the old result said, the claim time what it was applied at.
      await q(`
        UPDATE "SyncOperation"
           SET "status" = "result", "claimedAt" = "appliedAt", "createdAt" = "appliedAt",
               "completedAt" = CASE WHEN "result" = 'pending' THEN NULL ELSE "appliedAt" END
         WHERE "status" IS NULL AND "result" IS NOT NULL
      `);
      await q(`
        ALTER TABLE "SyncOperation" DROP CONSTRAINT IF EXISTS "SyncOperation_status_check";
        ALTER TABLE "SyncOperation" ADD CONSTRAINT "SyncOperation_status_check"
          CHECK ("status" IN ('pending', 'applied', 'merged', 'conflict', 'rejected'));
        CREATE INDEX IF NOT EXISTS "SyncOperation_pending_idx" ON "SyncOperation" ("status", "claimedAt") WHERE "status" = 'pending';
        CREATE INDEX IF NOT EXISTS "SyncOperation_createdAt_idx" ON "SyncOperation" ("createdAt");
      `);

      // ---- SyncConflict -----------------------------------------------------------------------------------------
      await q(`
        CREATE TABLE IF NOT EXISTS "SyncConflict" (
          "shopId" UUID NOT NULL,
          "opId" UUID NOT NULL,
          "deviceId" TEXT NOT NULL,
          "productId" UUID NOT NULL,
          "kind" TEXT NOT NULL CHECK ("kind" IN ('oversold', 'quantity_limit')),
          "requested" INTEGER NOT NULL,
          "applied" INTEGER NOT NULL,
          "shortfall" INTEGER NOT NULL,
          "quantityAfter" INTEGER NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'dismissed')),
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "dismissedAt" TIMESTAMPTZ NULL,
          "dismissedBy" UUID NULL,
          PRIMARY KEY ("shopId", "opId")
        );
        CREATE INDEX IF NOT EXISTS "SyncConflict_list_idx" ON "SyncConflict" ("shopId", "status", "createdAt" DESC, "opId" DESC);
        CREATE INDEX IF NOT EXISTS "SyncConflict_open_idx" ON "SyncConflict" ("status") WHERE "status" = 'open';
      `);

      // ---- ShopChangeLog / ShopSyncState ------------------------------------------------------------------------
      await q(`
        ALTER TABLE "ShopChangeLog" ALTER COLUMN "data" DROP NOT NULL;
        ALTER TABLE "ShopChangeLog" ADD COLUMN IF NOT EXISTS "version" INTEGER NULL;
        ALTER TABLE "ShopChangeLog" ADD COLUMN IF NOT EXISTS "deleted" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "ShopChangeLog" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMPTZ NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS "ShopChangeLog_version_uq" ON "ShopChangeLog" ("shopId", "entityId", "version");
        CREATE INDEX IF NOT EXISTS "ShopChangeLog_entity_idx" ON "ShopChangeLog" ("shopId", "entityId", "version" DESC);
        CREATE INDEX IF NOT EXISTS "ShopChangeLog_at_idx" ON "ShopChangeLog" ("shopId", "at");

        ALTER TABLE "ShopSyncState" ADD COLUMN IF NOT EXISTS "generation" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "ShopSyncState" ADD COLUMN IF NOT EXISTS "horizonSeq" BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE "ShopSyncState" ADD COLUMN IF NOT EXISTS "horizonAt" TIMESTAMPTZ NULL;
        ALTER TABLE "ShopSyncState" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();
      `);

      // ---- ProductFieldClock ------------------------------------------------------------------------------------
      const [[hasShop]] = await q(`
        SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'ProductFieldClock' AND column_name = 'shopId'
      `);
      if (!hasShop.n) {
        await q(`ALTER TABLE "ProductFieldClock" ADD COLUMN "shopId" UUID NULL`);
        // The one read of the product table: a data step of this migration, not application code.
        await q(`
          UPDATE "ProductFieldClock" c SET "shopId" = p."shopId" FROM "Product" p WHERE p."id" = c."productId"
        `);
        await q(`DELETE FROM "ProductFieldClock" WHERE "shopId" IS NULL`);
        await q(`
          UPDATE "ProductFieldClock" SET "field" = 'priceMinor' WHERE "field" = 'price';
          ALTER TABLE "ProductFieldClock" ALTER COLUMN "shopId" SET NOT NULL;
          ALTER TABLE "ProductFieldClock" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();
          ALTER TABLE "ProductFieldClock" DROP CONSTRAINT IF EXISTS "ProductFieldClock_pkey";
          ALTER TABLE "ProductFieldClock" ADD CONSTRAINT "ProductFieldClock_pkey" PRIMARY KEY ("shopId", "productId", "field");
        `);
      }
    });

    // CONCURRENTLY can't run inside a transaction block; a failed build leaves an invalid index that is dropped first.
    await sequelize.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                    WHERE c.relname = 'SyncOperation_shop_op_uq' AND c.relnamespace = current_schema()::regnamespace AND NOT i.indisvalid)
        THEN DROP INDEX "SyncOperation_shop_op_uq"; END IF;
      END $$
    `);
    await sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "SyncOperation_shop_op_uq" ON "SyncOperation" ("shopId", "opId")`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS "SyncConflict";
      DROP INDEX IF EXISTS "SyncOperation_shop_op_uq";
    `);
  },
};
