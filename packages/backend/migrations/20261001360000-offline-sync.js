'use strict';

/**
 * SD-06 offline sync.
 *  - SyncOperation: every client op by its client-generated id → pushing the
 *    same batch twice applies nothing twice.
 *  - ShopChangeLog: per-shop gap-free sequence, written by a TRIGGER on
 *    Product, so stock changes from orders / public API / dashboard reach
 *    offline devices too (not only changes made through sync). The per-shop
 *    counter row lock serializes writers per shop, which is what makes
 *    "everything after cursor N" safe (no commit-order holes).
 *  - ProductFieldClock: per-field HLC for last-writer-wins merges.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "SyncOperation" (
        "opId" UUID PRIMARY KEY,
        "shopId" UUID NOT NULL,
        "deviceId" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "hlc" TEXT NOT NULL,
        "result" TEXT NOT NULL,
        "detail" JSONB NULL,
        "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "SyncOperation_conflicts_idx" ON "SyncOperation" ("shopId", "appliedAt") WHERE result = 'conflict';

      CREATE TABLE IF NOT EXISTS "ShopSyncState" ("shopId" UUID PRIMARY KEY, "lastSeq" BIGINT NOT NULL DEFAULT 0);

      CREATE TABLE IF NOT EXISTS "ShopChangeLog" (
        "shopId" UUID NOT NULL,
        "seq" BIGINT NOT NULL,
        "entity" TEXT NOT NULL,
        "entityId" UUID NOT NULL,
        "data" JSONB NOT NULL,
        "at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("shopId", "seq")
      );

      CREATE TABLE IF NOT EXISTS "ProductFieldClock" (
        "productId" UUID NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
        "field" TEXT NOT NULL,
        "hlc" TEXT NOT NULL,
        PRIMARY KEY ("productId", "field")
      );

      CREATE OR REPLACE FUNCTION product_change_log() RETURNS trigger AS $$
      DECLARE next_seq BIGINT;
      BEGIN
        IF NEW."shopId" IS NULL THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity AND NEW.title IS NOT DISTINCT FROM OLD.title
           AND NEW.price IS NOT DISTINCT FROM OLD.price AND NEW.description IS NOT DISTINCT FROM OLD.description THEN
          RETURN NEW;
        END IF;
        INSERT INTO "ShopSyncState" ("shopId", "lastSeq") VALUES (NEW."shopId", 1)
        ON CONFLICT ("shopId") DO UPDATE SET "lastSeq" = "ShopSyncState"."lastSeq" + 1
        RETURNING "lastSeq" INTO next_seq;
        INSERT INTO "ShopChangeLog" ("shopId", seq, entity, "entityId", data)
        VALUES (NEW."shopId", next_seq, 'product', NEW.id,
                jsonb_build_object('quantity', NEW.quantity, 'title', NEW.title, 'price', NEW.price, 'description', NEW.description, 'version', NEW.version));
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS product_change_log_trg ON "Product";
      CREATE TRIGGER product_change_log_trg AFTER INSERT OR UPDATE ON "Product" FOR EACH ROW EXECUTE FUNCTION product_change_log();
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS product_change_log_trg ON "Product";
      DROP FUNCTION IF EXISTS product_change_log();
      DROP TABLE IF EXISTS "ProductFieldClock", "ShopChangeLog", "ShopSyncState", "SyncOperation";
    `);
  },
};
