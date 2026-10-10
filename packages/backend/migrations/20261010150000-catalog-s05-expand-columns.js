'use strict';

/**
 * S05 catalog, expand step 1 (III.11; reversible; additive for every legacy writer):
 *  - "Product": status (+ check), createdBy (copy of sellerId), isSandbox, currency, priceMinor (kept equal to the
 *    legacy price by a trigger until the last reader of "price" has moved), version starts at 1, checks on quantity
 *    and version added NOT VALID (the contract migration validates them), list index.
 * Backfills run in batches outside the DDL transaction. Indexes are created CONCURRENTLY.
 */
const BATCH = 5000;

module.exports = {
  async up(queryInterface) {
    const q = (sql, options = {}) =>
      queryInterface.sequelize.query(sql, options);
    const currency = /^[A-Z]{3}$/.test(process.env.PLATFORM_CURRENCY ?? '')
      ? process.env.PLATFORM_CURRENCY
      : 'USD';

    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => q(sql, { transaction });
      await t(`SET LOCAL lock_timeout = '3s'`);
      await t(`
        ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE';
        ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_status_check";
        ALTER TABLE "Product" ADD CONSTRAINT "Product_status_check" CHECK ("status" IN ('ACTIVE','ARCHIVED'));
        ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "createdBy" UUID NULL;
        ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "isSandbox" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(3) NOT NULL DEFAULT '${currency}';
        ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "priceMinor" BIGINT NULL;
        ALTER TABLE "Product" ALTER COLUMN "version" SET DEFAULT 1;

        -- "price" (legacy name) and "priceMinor" stay equal whichever one a writer sets.
        CREATE OR REPLACE FUNCTION product_price_mirror() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            IF NEW."priceMinor" IS NULL THEN NEW."priceMinor" := NEW."price";
            ELSIF NEW."price" IS NULL THEN NEW."price" := NEW."priceMinor";
            END IF;
          ELSIF NEW."priceMinor" IS DISTINCT FROM OLD."priceMinor" THEN
            NEW."price" := NEW."priceMinor";
          ELSIF NEW."price" IS DISTINCT FROM OLD."price" THEN
            NEW."priceMinor" := NEW."price";
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        DROP TRIGGER IF EXISTS product_price_mirror_trg ON "Product";
        CREATE TRIGGER product_price_mirror_trg BEFORE INSERT OR UPDATE ON "Product"
          FOR EACH ROW EXECUTE FUNCTION product_price_mirror();
      `);
    });

    const backfill = async (sql) => {
      for (;;) {
        const [, meta] = await q(sql);
        if (!meta || meta.rowCount < BATCH) return;
      }
    };
    await backfill(
      `UPDATE "Product" SET "createdBy" = "sellerId" WHERE "id" IN (
         SELECT "id" FROM "Product" WHERE "createdBy" IS NULL AND "sellerId" IS NOT NULL LIMIT ${BATCH})`,
    );
    await backfill(
      `UPDATE "Product" SET "priceMinor" = "price" WHERE "id" IN (
         SELECT "id" FROM "Product" WHERE "priceMinor" IS NULL LIMIT ${BATCH})`,
    );
    await backfill(
      `UPDATE "Product" SET "version" = 1 WHERE "id" IN (
         SELECT "id" FROM "Product" WHERE "version" < 1 LIMIT ${BATCH})`,
    );

    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => q(sql, { transaction });
      await t(`SET LOCAL lock_timeout = '3s'`);
      await t(`
        ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_priceMinor_set";
        ALTER TABLE "Product" ADD CONSTRAINT "Product_priceMinor_set" CHECK ("priceMinor" IS NOT NULL) NOT VALID;
        ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_version_check";
        ALTER TABLE "Product" ADD CONSTRAINT "Product_version_check" CHECK ("version" >= 1) NOT VALID;
        ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_quantity_check";
        ALTER TABLE "Product" ADD CONSTRAINT "Product_quantity_check"
          CHECK ("quantity" >= 0 AND "quantity" <= 1000000000) NOT VALID;
      `);
    });
    // A validated check lets SET NOT NULL skip the table scan (PostgreSQL 12+); the trigger fills the column on insert.
    await q(`ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_priceMinor_set"`);
    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => q(sql, { transaction });
      await t(`SET LOCAL lock_timeout = '3s'`);
      await t(`ALTER TABLE "Product" ALTER COLUMN "priceMinor" SET NOT NULL`);
      await t(`ALTER TABLE "Product" DROP CONSTRAINT "Product_priceMinor_set"`);
    });

    await q(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Product_shop_created_id_idx" ON "Product" ("shopId", "createdAt" DESC, "id" DESC)`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS "Product_shop_created_id_idx"`,
    );
    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await t(`SET LOCAL lock_timeout = '3s'`);
      await t(`
        DROP TRIGGER IF EXISTS product_price_mirror_trg ON "Product";
        DROP FUNCTION IF EXISTS product_price_mirror();
        ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_quantity_check";
        ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_version_check";
        ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_priceMinor_set";
        ALTER TABLE "Product" ALTER COLUMN "version" SET DEFAULT 0;
        ALTER TABLE "Product" DROP COLUMN IF EXISTS "priceMinor";
        ALTER TABLE "Product" DROP COLUMN IF EXISTS "currency";
        ALTER TABLE "Product" DROP COLUMN IF EXISTS "isSandbox";
        ALTER TABLE "Product" DROP COLUMN IF EXISTS "createdBy";
        ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_status_check";
        ALTER TABLE "Product" DROP COLUMN IF EXISTS "status";
      `);
    });
  },
};
