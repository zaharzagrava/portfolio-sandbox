'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Payment', 'userId', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    // Populate existing payments with userId from BisOrder
    await queryInterface.sequelize.query(`
      UPDATE "Payment"
      SET "userId" = "BisOrder"."userId"
      FROM "BisOrder"
      WHERE "Payment"."bisOrderId" = "BisOrder"."id"
    `);

    // Make it NOT NULL after populating
    await queryInterface.changeColumn('Payment', 'userId', {
      type: Sequelize.STRING,
      allowNull: false,
    });

    await queryInterface.addIndex('Payment', ['userId', { name: 'id', order: 'DESC' }], {
      name: 'idx_payment_user_id_desc',
    });

    await queryInterface.removeColumn('Payment', 'productId');
    await queryInterface.removeColumn('Payment', 'quantity');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('Payment', 'productId', {
      type: Sequelize.UUID,
      allowNull: true,
    });
    await queryInterface.addColumn('Payment', 'quantity', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 1,
    });

    await queryInterface.removeIndex('Payment', 'idx_payment_user_id_desc');
    await queryInterface.removeColumn('Payment', 'userId');
  },
};
