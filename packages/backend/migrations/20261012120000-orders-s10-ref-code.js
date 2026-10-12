'use strict';

/**
 * S10 AS-69, expand step (III.11; reversible; additive): "BisOrder"."refCode", the buyer's optional referral code.
 * Nullable with no default, so every legacy writer keeps working.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "BisOrder" ADD COLUMN IF NOT EXISTS "refCode" TEXT NULL`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "BisOrder" DROP COLUMN IF EXISTS "refCode"`,
    );
  },
};
