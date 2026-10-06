'use strict';

/**
 * Payment optionally targets a Product purchase — productId/quantity let the
 * payment transaction do a version-checked stock decrement in the same tx as
 * the ledger write, instead of a separate saga step.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      const paymentDesc = await queryInterface.describeTable('Payment');

      if (!paymentDesc.productId) {
        await queryInterface.addColumn(
          'Payment',
          'productId',
          {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: 'Product', key: 'id' },
          },
          { transaction },
        );
      }

      if (!paymentDesc.quantity) {
        await queryInterface.addColumn(
          'Payment',
          'quantity',
          {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 1,
          },
          { transaction },
        );
      }
    });
  },

  async down(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      const paymentDesc = await queryInterface.describeTable('Payment');

      if (paymentDesc.quantity) {
        await queryInterface.removeColumn('Payment', 'quantity', { transaction });
      }
      if (paymentDesc.productId) {
        await queryInterface.removeColumn('Payment', 'productId', { transaction });
      }
    });
  },
};
