'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'Outbox',
        {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.literal('uuidv7()'),
            allowNull: false,
            primaryKey: true,
          },
          topic: {
            type: Sequelize.ENUM(...Object.values(['payments.requests', 'payments.responses', 'payments.dlq'])),
            allowNull: false,
          },
          extra: {
            type: Sequelize.JSONB,
            allowNull: true,
          },
          payload: {
            type: Sequelize.JSONB,
            allowNull: false,
          },
          error: {
            type: Sequelize.JSONB,
            allowNull: true,
          },
          createdAt: {
            allowNull: false,
            type: Sequelize.DATE,
          },
        },
        { transaction },
      );

    });
  },

  async down(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      // Drop in reverse order to satisfy FKs
      await queryInterface.dropTable('Outbox', { transaction })
    });
  },
};
