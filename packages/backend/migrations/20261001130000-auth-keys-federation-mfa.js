'use strict';

/**
 * SD-39:
 *  - SigningKey: rotating JWT signing keys published via JWKS. Private keys are
 *    stored encrypted (AES-256-GCM, KEK from Secrets Manager / env) - never in
 *    plaintext, never in the JWKS.
 *  - FederatedIdentity: (provider, subject) → user, for OIDC logins
 *    (Google, per-shop enterprise IdPs). UNIQUE(provider, subject).
 *  - User MFA columns (TOTP secret encrypted, hashed recovery codes).
 *  - lower(email) expression index: login lookups are case-insensitive
 *    without a function-on-column seq scan (lesson 03/01 §3.4).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '5s'`);
      await q(`
        CREATE TABLE IF NOT EXISTS "SigningKey" (
          "kid" TEXT PRIMARY KEY,
          "alg" TEXT NOT NULL,
          "publicJwk" JSONB NOT NULL,
          "privateKeyEnc" TEXT NOT NULL,
          "status" TEXT NOT NULL CHECK ("status" IN ('NEXT','ACTIVE','RETIRED')),
          "activatedAt" TIMESTAMPTZ NULL,
          "retiredAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- At most one ACTIVE key at any time.
        CREATE UNIQUE INDEX IF NOT EXISTS "SigningKey_one_active" ON "SigningKey" ("status") WHERE "status" = 'ACTIVE';

        CREATE TABLE IF NOT EXISTS "FederatedIdentity" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
          "provider" TEXT NOT NULL,
          "subject" TEXT NOT NULL,
          "email" TEXT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE ("provider", "subject")
        );
        CREATE INDEX IF NOT EXISTS "FederatedIdentity_user_idx" ON "FederatedIdentity" ("userId");

        ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaSecretEnc" TEXT NULL;
        ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaEnabledAt" TIMESTAMPTZ NULL;
        ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaRecoveryCodes" JSONB NULL;
      `);
    });
    // CONCURRENTLY can't run inside a transaction block.
    await queryInterface.sequelize.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_lower_email_idx" ON "User" (lower("email"))`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "User_lower_email_idx";
      ALTER TABLE "User" DROP COLUMN IF EXISTS "mfaRecoveryCodes";
      ALTER TABLE "User" DROP COLUMN IF EXISTS "mfaEnabledAt";
      ALTER TABLE "User" DROP COLUMN IF EXISTS "mfaSecretEnc";
      DROP TABLE IF EXISTS "FederatedIdentity";
      DROP TABLE IF EXISTS "SigningKey";
    `);
  },
};
