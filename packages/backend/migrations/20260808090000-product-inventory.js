'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'Product',
        {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.literal('uuidv7()'),
            allowNull: false,
            primaryKey: true,
          },
          title: {
            type: Sequelize.STRING,
            allowNull: false,
          },
          description: {
            type: Sequelize.TEXT,
            allowNull: false,
          },
          brand: {
            type: Sequelize.STRING,
            allowNull: false,
          },
          category: {
            type: Sequelize.STRING,
            allowNull: false,
          },
          price: {
            type: Sequelize.BIGINT,
            allowNull: false,
          },
          rating: {
            type: Sequelize.FLOAT,
            allowNull: false,
            defaultValue: 0,
          },
          tags: {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: [],
          },
          quantity: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          version: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          embedding: {
            type: Sequelize.JSONB,
            allowNull: true,
          },
          createdAt: {
            allowNull: false,
            type: Sequelize.DATE,
          },
          updatedAt: {
            allowNull: false,
            type: Sequelize.DATE,
          },
        },
        { transaction },
      );

      await queryInterface.addIndex('Product', ['category'], { transaction });
      await queryInterface.addIndex('Product', ['brand'], { transaction });
    });
  },

  async down(queryInterface) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('Product', { transaction });
    });
  },
};
