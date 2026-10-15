'use strict';

/**
 * S10 provider side for S16 (specs/domains/S16-seller-statements, research R-1 / gaps D1): an order line keeps the
 * product's category as it was at purchase (IX.8: a copy, not a reference), so `order.paid` can carry it and the
 * seller statement prices the line with the category of the sale, not of today's catalog. Expand only: the column is
 * nullable, existing rows stay NULL (the history re-emit of S10 is what fills them), nothing is rewritten.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "BisOrderItem" ADD COLUMN IF NOT EXISTS "category" TEXT NULL`,
    );
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "BisOrderItem" DROP COLUMN IF EXISTS "category"`,
    );
  },
};
