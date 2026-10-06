'use strict';

/**
 * Outbox mailman fields: lets a poller find unpublished rows cheaply and
 * back off between retries without hammering Kafka.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      const outboxDesc = await queryInterface.describeTable('Outbox');

      if (!outboxDesc.publishedAt) {
        await queryInterface.addColumn(
          'Outbox',
          'publishedAt',
          {
            type: Sequelize.DATE,
            allowNull: true,
          },
          { transaction },
        );
      }

      if (!outboxDesc.attempts) {
        await queryInterface.addColumn(
          'Outbox',
          'attempts',
          {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          { transaction },
        );
      }

      if (!outboxDesc.nextAttemptAt) {
        await queryInterface.addColumn(
          'Outbox',
          'nextAttemptAt',
          {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('NOW()'),
          },
          { transaction },
        );
      }

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS "outbox_unpublished_due_idx"
         ON "Outbox" ("nextAttemptAt")
         WHERE "publishedAt" IS NULL;`,
        { transaction },
      );
    });
  },

  async down(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `DROP INDEX IF EXISTS "outbox_unpublished_due_idx";`,
        { transaction },
      );

      const outboxDesc = await queryInterface.describeTable('Outbox');

      if (outboxDesc.nextAttemptAt) {
        await queryInterface.removeColumn('Outbox', 'nextAttemptAt', { transaction });
      }
      if (outboxDesc.attempts) {
        await queryInterface.removeColumn('Outbox', 'attempts', { transaction });
      }
      if (outboxDesc.publishedAt) {
        await queryInterface.removeColumn('Outbox', 'publishedAt', { transaction });
      }
    });
  },
};
