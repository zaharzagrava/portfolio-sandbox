'use strict';

/**
 * S02 identity (expand-only, III.11):
 *  - "SecondFactor" (one row per user, state pending|enabled), "MfaRecoveryCode" (one row per code, keyed digest) and
 *    "MfaChallengeState" (lazy per-challenge attempts/spent marker). Users that had a factor switched on are copied
 *    into "SecondFactor" (sealVersion 0 = sealed without context; the re-seal job binds them to the user). Pending
 *    enrolments and the legacy recovery codes are not copied: the first become "none", the second cannot be turned
 *    into keyed digests (research R-05).
 *  - "FederatedIdentity"."wipePending" (account-linking revocation that still has to be repeated).
 *  - UNIQUE ("userId","provider") on "FederatedIdentity", created CONCURRENTLY outside the transaction after a check
 *    that aborts, naming the pairs, instead of deleting anything.
 * The "User".mfa* columns stay untouched; a later contract migration drops them.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '5s'`);
      await q(`
        CREATE TABLE IF NOT EXISTS "SecondFactor" (
          "userId" UUID PRIMARY KEY,
          "state" TEXT NOT NULL CHECK ("state" IN ('pending','enabled')),
          "secretSealed" TEXT NOT NULL,
          "sealVersion" SMALLINT NOT NULL DEFAULT 0,
          "pendingExpiresAt" TIMESTAMPTZ NULL,
          "enabledAt" TIMESTAMPTZ NULL,
          "lastStep" BIGINT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS "MfaRecoveryCode" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "userId" UUID NOT NULL,
          "digest" TEXT NOT NULL,
          "usedAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT "MfaRecoveryCode_user_digest_uq" UNIQUE ("userId", "digest")
        );
        CREATE INDEX IF NOT EXISTS "MfaRecoveryCode_unused_idx" ON "MfaRecoveryCode" ("userId") WHERE "usedAt" IS NULL;

        CREATE TABLE IF NOT EXISTS "MfaChallengeState" (
          "jti" UUID PRIMARY KEY,
          "userId" UUID NOT NULL,
          "attempts" SMALLINT NOT NULL,
          "spentAt" TIMESTAMPTZ NULL,
          "expiresAt" TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "MfaChallengeState_expires_idx" ON "MfaChallengeState" ("expiresAt");

        ALTER TABLE "FederatedIdentity" ADD COLUMN IF NOT EXISTS "wipePending" BOOLEAN NOT NULL DEFAULT false;

        INSERT INTO "SecondFactor" ("userId","state","secretSealed","sealVersion","enabledAt","lastStep","createdAt","updatedAt")
        SELECT "id", 'enabled', "mfaSecretEnc", 0, "mfaEnabledAt", NULL, now(), now()
        FROM "User"
        WHERE "mfaEnabledAt" IS NOT NULL AND "mfaSecretEnc" IS NOT NULL
        ON CONFLICT ("userId") DO NOTHING;
      `);
    });

    // Duplicates would make the unique index fail half way; refuse up front and let a human decide which row stays.
    const [duplicates] = await queryInterface.sequelize.query(`
      SELECT "userId", "provider", count(*) AS "n"
      FROM "FederatedIdentity"
      GROUP BY "userId", "provider"
      HAVING count(*) > 1
    `);
    if (duplicates.length > 0)
      throw new Error(
        `FederatedIdentity has several rows for the same (userId, provider); resolve them, then run the migration again: ${duplicates
          .map((d) => `(${d.userId}, ${d.provider}) x${d.n}`)
          .join(', ')}`,
      );

    // CONCURRENTLY can't run inside a transaction block.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "FederatedIdentity_user_provider_uq" ON "FederatedIdentity" ("userId","provider")`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "FederatedIdentity_user_provider_uq";
      ALTER TABLE "FederatedIdentity" DROP COLUMN IF EXISTS "wipePending";
      DROP TABLE IF EXISTS "MfaChallengeState";
      DROP TABLE IF EXISTS "MfaRecoveryCode";
      DROP TABLE IF EXISTS "SecondFactor";
    `);
  },
};
