'use strict';

/**
 * S04 seller onboarding, contract step (III.11, A33; IX.4.3). Runs after the expand step
 * (`20261016001000-seller-onboarding-s04.js`) once the code needs neither of the following:
 *  - the foreign keys `ShopOnboarding.shopId -> Shop` and `ShopDocument.shopId -> Shop` (the shop is another domain's
 *    table: the IDs stay as plain columns, existence is checked through tenancy's exported service),
 *  - the old unique `(shopId, kind, contentHash)` of "ShopDocument", replaced by the per-round unique
 *    `(shopId, submissionNo, kind, contentHash)` (the same file is a new document in a later round, FR-012).
 * Idempotent (`IF EXISTS`), short lock timeout, one short transaction; no `Shop` column is touched.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(LOCK_TIMEOUT);
      await q(`ALTER TABLE "ShopOnboarding" DROP CONSTRAINT IF EXISTS "ShopOnboarding_shopId_fkey"`);
      await q(`ALTER TABLE "ShopDocument" DROP CONSTRAINT IF EXISTS "ShopDocument_shopId_fkey"`);
      await q(
        `ALTER TABLE "ShopDocument" DROP CONSTRAINT IF EXISTS "ShopDocument_shopId_kind_contentHash_key"`,
      );
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(LOCK_TIMEOUT);
      // The old unique can only come back while no shop has the same file in two rounds.
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ShopDocument_shopId_kind_contentHash_key') THEN
          ALTER TABLE "ShopDocument" ADD CONSTRAINT "ShopDocument_shopId_kind_contentHash_key"
            UNIQUE ("shopId", "kind", "contentHash");
        END IF;
      END $$`);
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ShopDocument_shopId_fkey') THEN
          ALTER TABLE "ShopDocument" ADD CONSTRAINT "ShopDocument_shopId_fkey"
            FOREIGN KEY ("shopId") REFERENCES "Shop"("id") NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ShopOnboarding_shopId_fkey') THEN
          ALTER TABLE "ShopOnboarding" ADD CONSTRAINT "ShopOnboarding_shopId_fkey"
            FOREIGN KEY ("shopId") REFERENCES "Shop"("id") NOT VALID;
        END IF;
      END $$`);
    });
  },
};
