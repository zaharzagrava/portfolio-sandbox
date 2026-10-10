'use strict';

/**
 * S13 payments, expand step 2: the new status value, alone in its migration and outside a transaction (the runner
 * does not wrap migrations) so it is committed before any code writes it.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_Payment_status" ADD VALUE IF NOT EXISTS 'REFUND_PENDING'`,
    );
  },

  // An enum value cannot be removed; REFUND_PENDING is simply unused after a rollback of the code.
  async down() {},
};
