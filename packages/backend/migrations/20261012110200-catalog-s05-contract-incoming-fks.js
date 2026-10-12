'use strict';

/**
 * S05 catalog, contract step 3 (III.11, IX.4): no table references "Product" by foreign key any more; other domains keep
 * a plain productId and clean up on the catalog.product_* events. This also removes the KEY SHARE lock that
 * "BisOrderItem"."productId" took against applyStockDelta's FOR UPDATE. Each constraint is dropped in its own short
 * transaction with a lock timeout.
 */
const INCOMING_FOREIGN_KEYS = `
  SELECT c.conrelid::regclass::text AS tbl, c.conname FROM pg_constraint c
  WHERE c.contype = 'f' AND c.confrelid = '"Product"'::regclass`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const [rows] = await sequelize.query(INCOMING_FOREIGN_KEYS);
    for (const { tbl, conname } of rows) {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(`SET LOCAL lock_timeout = '3s'`, { transaction });
        await sequelize.query(
          `ALTER TABLE ${tbl} DROP CONSTRAINT IF EXISTS "${conname}"`,
          { transaction },
        );
      });
    }
  },

  async down() {
    // Not restored: the constraints belonged to other domains' tables and rows may already reference deleted products.
  },
};
