'use strict';

/**
 * S05 catalog, contract step 1 (III.11, IX.4): "Product" no longer references identity's "User" or tenancy's "Shop";
 * cross-domain references are plain ids. Each constraint is dropped in its own short transaction with a lock timeout.
 * Deploy after the code that no longer relies on the cascade (shop purge is the catalog's own job) is running.
 */
const FOREIGN_KEYS_OF_PRODUCT = `
  SELECT c.conname FROM pg_constraint c
  WHERE c.contype = 'f' AND c.conrelid = '"Product"'::regclass
    AND c.confrelid IN ('"User"'::regclass, '"Shop"'::regclass)`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const [rows] = await sequelize.query(FOREIGN_KEYS_OF_PRODUCT);
    for (const { conname } of rows) {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(`SET LOCAL lock_timeout = '3s'`, { transaction });
        await sequelize.query(
          `ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "${conname}"`,
          { transaction },
        );
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`ALTER TABLE "Product" ADD CONSTRAINT "Product_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") NOT VALID`);
      await q(`ALTER TABLE "Product" ADD CONSTRAINT "Product_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") NOT VALID`);
    });
  },
};
