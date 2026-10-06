'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      // Create unique index on idempotencyKey for Payment table
      await queryInterface.addIndex(
        'Payment',
        ['idempotencyKey'],
        {
          unique: true,
          name: 'payment_idempotency_key_unique',
          transaction,
        }
      );
    });
  },

  async down(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      // Remove the unique index on idempotencyKey of Payment
      await queryInterface.removeIndex(
        'Payment',
        'payment_idempotency_key_unique',
        { transaction }
      );
    });
  },
};
