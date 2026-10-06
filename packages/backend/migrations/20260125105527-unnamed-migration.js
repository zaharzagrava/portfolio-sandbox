'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'User',
        {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.literal('uuidv7()'),
            allowNull: false,
            primaryKey: true,
          },
          createdAt: {
            allowNull: false,
            type: Sequelize.DATE,
          },
          updatedAt: {
            allowNull: false,
            type: Sequelize.DATE,
          },
          deletedAt: {
            allowNull: true,
            type: Sequelize.DATE,
          },
        },
        { transaction },
      );

      await queryInterface.createTable(
        'BisOrder',
        {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.literal('uuidv7()'),
            allowNull: false,
            primaryKey: true,
          },
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: {
              model: 'User',
              key: 'id',
            },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
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

      await queryInterface.createTable(
        'Payment',
        {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.literal('uuidv7()'),
            allowNull: false,
            primaryKey: true,
          },
          idempotencyKey: {
            type: Sequelize.STRING,
            allowNull: false,
          },
          amount: {
            type: Sequelize.BIGINT,
            allowNull: false,
          },
          status: {
            type: Sequelize.ENUM(...Object.values(['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED'])),
            allowNull: false,
            defaultValue: 'PENDING',
          },
          bisOrderId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: {
              model: 'BisOrder',
              key: 'id',
            },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
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

      await queryInterface.createTable(
        'LedgerEntry',
        {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.literal('uuidv7()'),
            allowNull: false,
            primaryKey: true,
          },
          paymentId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: {
              model: 'Payment',
              key: 'id',
            },
            onDelete: 'RESTRICT',
            onUpdate: 'CASCADE',
          },
          accountId: {
            type: Sequelize.STRING,
            allowNull: false,
          },
          amount: {
            type: Sequelize.BIGINT,
            allowNull: false,
          },
          createdAt: {
            allowNull: false,
            type: Sequelize.DATE,
          },
        },
        { transaction },
      );

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
          payload: {
            type: Sequelize.JSONB,
            allowNull: false,
          },
          processed: {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          createdAt: {
            allowNull: false,
            type: Sequelize.DATE,
          },
        },
        { transaction },
      );

      // Migration (app-level)
      await queryInterface.createTable(
        'Migration',
        {
          id: {
            type: Sequelize.STRING,
            allowNull: false,
            primaryKey: true,
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

    });
  },

  async down(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      // Drop in reverse order to satisfy FKs
      await queryInterface.dropTable('Migration', { transaction })
      await queryInterface.dropTable('User', { transaction });
    });
  },
};
