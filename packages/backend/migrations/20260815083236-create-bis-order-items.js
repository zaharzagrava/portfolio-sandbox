'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('BisOrderItem', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
      },
      bisOrderId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'BisOrder',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      productId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'Product',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      quantity: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      priceAtPurchase: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('BisOrderItem');
  },
};
