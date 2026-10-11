'use strict';

/**
 * W01 / S01 FR-080..FR-084 (expand-only, III.11). The table "PasswordResetToken" (digest of a single-use token, the raw
 * token is never stored) was created by 20261010090000-identity-s01-expand; W01 starts using it and adds the index the
 * expired-token purge and the validity check read by.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS "PasswordResetToken_expires_idx" ON "PasswordResetToken" ("expiresAt")`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS "PasswordResetToken_expires_idx"`,
    );
  },
};
