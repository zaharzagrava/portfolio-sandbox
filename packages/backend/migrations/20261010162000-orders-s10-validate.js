'use strict';

/**
 * S10 orders: validates the checks added NOT VALID by the expand migration (the scan takes only a SHARE UPDATE
 * EXCLUSIVE lock). The contract migration (NOT NULL on title and lineTotalMinor, foreign keys) is a later release,
 * after the title backfill job has finished.
 */
const CHECKS = [
  ['StockReservation', 'StockReservation_source_check'],
  ['StockReservation', 'StockReservation_status_check'],
  ['BisOrder', 'BisOrder_status_check'],
  ['ShopOrder', 'ShopOrder_status_check'],
  ['BisOrderItem', 'BisOrderItem_lineTotal_check'],
];

module.exports = {
  async up(queryInterface) {
    for (const [table, name] of CHECKS)
      await queryInterface.sequelize.query(
        `ALTER TABLE "${table}" VALIDATE CONSTRAINT "${name}"`,
      );
  },

  async down() {
    // Validation has nothing to undo.
  },
};
