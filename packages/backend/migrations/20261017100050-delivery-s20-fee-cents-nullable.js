'use strict';

/**
 * S20, bridge between the expand step and the manual contract step (migrations/contract/20261017100100-delivery-s20-contract.js).
 * The code no longer writes the draft column "feeCents" (it writes "feeMinor"), so a stack that only ran the expand step
 * must not keep it NOT NULL. Idempotent; the contract step drops the column.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'Delivery' AND column_name = 'feeCents') THEN
          ALTER TABLE "Delivery" ALTER COLUMN "feeCents" DROP NOT NULL;
        END IF;
      END $$;
    `);
  },

  async down() {
    // The column is draft-only; restoring NOT NULL would fail on rows written without it.
  },
};
