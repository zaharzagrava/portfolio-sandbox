'use strict';

/**
 * For environments that already applied the earlier Product+Inventory migration:
 * drop Inventory and move stock onto Product.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      const tables = await queryInterface.showAllTables();
      const normalized = tables.map((t) =>
        typeof t === 'string' ? t : t.tableName || t,
      );

      if (normalized.includes('Inventory')) {
        await queryInterface.dropTable('Inventory', { transaction });
      }

      const productDesc = await queryInterface.describeTable('Product');

      if (!productDesc.quantity) {
        await queryInterface.addColumn(
          'Product',
          'quantity',
          {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          { transaction },
        );
      }

      if (!productDesc.version) {
        await queryInterface.addColumn(
          'Product',
          'version',
          {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          { transaction },
        );
      }
    });
  },

  async down(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      const productDesc = await queryInterface.describeTable('Product');

      if (productDesc.version) {
        await queryInterface.removeColumn('Product', 'version', { transaction });
      }
      if (productDesc.quantity) {
        await queryInterface.removeColumn('Product', 'quantity', { transaction });
      }

      await queryInterface.createTable(
        'Inventory',
        {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.literal('uuidv7()'),
            allowNull: false,
            primaryKey: true,
          },
          productId: {
            type: Sequelize.UUID,
            allowNull: false,
            unique: true,
            references: { model: 'Product', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
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
          createdAt: { allowNull: false, type: Sequelize.DATE },
          updatedAt: { allowNull: false, type: Sequelize.DATE },
        },
        { transaction },
      );
    });
  },
};
