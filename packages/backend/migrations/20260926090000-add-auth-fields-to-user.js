'use strict';

/**
 * Password login + roles. `email`/`passwordHash` stay nullable so users
 * created before auth existed (and anything seeded by id only) remain valid;
 * the unique index still holds because Postgres treats NULLs as distinct.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      const userDesc = await queryInterface.describeTable('User');

      if (!userDesc.email) {
        await queryInterface.addColumn(
          'User',
          'email',
          { type: Sequelize.STRING, allowNull: true },
          { transaction },
        );
      }

      if (!userDesc.passwordHash) {
        await queryInterface.addColumn(
          'User',
          'passwordHash',
          { type: Sequelize.STRING, allowNull: true },
          { transaction },
        );
      }

      if (!userDesc.role) {
        await queryInterface.addColumn(
          'User',
          'role',
          {
            type: Sequelize.ENUM('USER', 'SELLER', 'MODERATOR', 'ADMIN'),
            allowNull: false,
            defaultValue: 'USER',
          },
          { transaction },
        );
      }

      await queryInterface.addIndex('User', ['email'], {
        unique: true,
        name: 'user_email_unique',
        transaction,
      });
    });
  },

  async down(queryInterface) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex('User', 'user_email_unique', { transaction });
      await queryInterface.removeColumn('User', 'role', { transaction });
      await queryInterface.removeColumn('User', 'passwordHash', { transaction });
      await queryInterface.removeColumn('User', 'email', { transaction });
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_User_role";', {
        transaction,
      });
    });
  },
};
