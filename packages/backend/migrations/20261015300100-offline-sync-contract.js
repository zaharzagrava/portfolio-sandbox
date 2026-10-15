'use strict';

/**
 * S09 contract (specs/domains/S09-offline-sync/data-model.md, research R-16), run after no code reads the legacy
 * shape. Repeatable; every statement runs under `lock_timeout = '3s'`.
 *
 *  - drops the trigger `product_change_log_trg` on the product table and its function: the feed is built from the
 *    catalog's events now (S05 R3), not by a trigger on another owner's table (IX.4)
 *  - drops the foreign key (and its cascade) of `ProductFieldClock` to the product table
 *  - `SyncOperation`: the old single-column primary key and the legacy `result` / `appliedAt` columns go; the unique
 *    `(shopId, opId)` index becomes the primary key
 *
 * `down` is meant for a throwaway database only.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);

      await q(`
        DROP TRIGGER IF EXISTS product_change_log_trg ON "Product";
        DROP FUNCTION IF EXISTS product_change_log();
      `);
      await q(`
        DO $$ DECLARE c record; BEGIN
          FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = '"ProductFieldClock"'::regclass AND contype = 'f' LOOP
            EXECUTE format('ALTER TABLE "ProductFieldClock" DROP CONSTRAINT %I', c.conname);
          END LOOP;
        END $$
      `);
      await q(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
             WHERE i.indrelid = '"SyncOperation"'::regclass AND i.indisprimary AND a.attname = 'shopId'
          ) THEN
            ALTER TABLE "SyncOperation" DROP CONSTRAINT IF EXISTS "SyncOperation_pkey";
            ALTER TABLE "SyncOperation" ADD CONSTRAINT "SyncOperation_pkey" PRIMARY KEY USING INDEX "SyncOperation_shop_op_uq";
          END IF;
        END $$
      `);
      await q(`
        DROP INDEX IF EXISTS "SyncOperation_conflicts_idx";
        ALTER TABLE "SyncOperation" DROP COLUMN IF EXISTS "result";
        ALTER TABLE "SyncOperation" DROP COLUMN IF EXISTS "appliedAt";
        ALTER TABLE "SyncOperation" ALTER COLUMN "status" SET NOT NULL;
        ALTER TABLE "SyncOperation" ALTER COLUMN "claimedAt" SET NOT NULL;
        ALTER TABLE "SyncOperation" ALTER COLUMN "claimedAt" SET DEFAULT now();
      `);
    });
  },

  async down() {
    // Throwaway databases only: the legacy trigger is not restored.
  },
};
