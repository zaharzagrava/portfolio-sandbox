'use strict';

/**
 * S01 identity (expand-only, III.11):
 *  - "User" gets a UNIQUE index on lower(email): case variants of one address are the same account, enforced by the
 *    store (registration races, AS-03), and lookups by lower(email) use it (A6). The older non-unique
 *    "User_lower_email_idx" stays until a contract step.
 *  - At most one NEXT signing key, beside the existing one-ACTIVE index.
 *  - "PasswordResetToken": digest of a single-use reset token (the raw token is never stored).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '5s'`);
      await q(`
        CREATE UNIQUE INDEX IF NOT EXISTS "SigningKey_one_next" ON "SigningKey" ("status") WHERE "status" = 'NEXT';

        CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "userId" UUID NOT NULL,
          "digest" TEXT NOT NULL UNIQUE,
          "expiresAt" TIMESTAMPTZ NOT NULL,
          "usedAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "PasswordResetToken_user_idx" ON "PasswordResetToken" ("userId");
      `);
    });
    // CONCURRENTLY can't run inside a transaction block.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "User_lower_email_uq" ON "User" (lower("email")) WHERE "email" IS NOT NULL`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "User_lower_email_uq";
      DROP TABLE IF EXISTS "PasswordResetToken";
      DROP INDEX IF EXISTS "SigningKey_one_next";
    `);
  },
};
