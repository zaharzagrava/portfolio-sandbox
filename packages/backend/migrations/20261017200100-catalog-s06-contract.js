'use strict';

/**
 * S06 collaborative drafts, contract step (III.11, IX.4): the draft tables hold plain ids of the shop, the product and the
 * user; no foreign key to another domain's table. Cleanup follows the `tenancy.shop_deleted` event and the code never
 * joins these tables. Each constraint is dropped in its own short transaction with a lock timeout. No data migration.
 */
const OUTGOING_FOREIGN_KEYS = `
  SELECT c.conrelid::regclass::text AS tbl, c.conname FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.conrelid IN ('"ListingDraft"'::regclass, '"ListingDraftVersion"'::regclass)
    AND c.confrelid NOT IN ('"ListingDraft"'::regclass, '"ListingDraftVersion"'::regclass)`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const [rows] = await sequelize.query(OUTGOING_FOREIGN_KEYS);
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
    // Not restored: rows may already reference shops, products or users owned by other domains that were deleted.
  },
};
