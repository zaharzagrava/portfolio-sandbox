'use strict';

/**
 * S14 payments, expand step 1b: the total of a payment-bound journal on its header ("amountMinor": what was captured
 * for a SALE, refunded for a REFUND). The reconciliation matches the provider's statement against headers by
 * reference and amount, and must not sum entries to find it. Nullable: other kinds have no such total; the backfill
 * fills it for the legacy headers.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`ALTER TABLE "LedgerJournal" ADD COLUMN IF NOT EXISTS "amountMinor" BIGINT NULL`);
    });
  },

  async down() {
    throw new Error('Irreversible: the column is read by the reconciliation.');
  },
};
