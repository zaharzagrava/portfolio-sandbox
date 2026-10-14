'use strict';

/**
 * S38 flags lifecycle, expand only (research.md R-25). Adds `status`, `createdAt`, `requestId`, the `FlagRuleset`
 * version row and the indexes; backfills; keeps `enabled` for readers still running during the deploy. Idempotent
 * (`IF NOT EXISTS`, drop-then-add for constraints) and every statement runs under a 5 s `lock_timeout`.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';

        ALTER TABLE "FeatureFlag" ADD COLUMN IF NOT EXISTS "status" TEXT NULL;
        ALTER TABLE "FeatureFlag" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NULL;
        UPDATE "FeatureFlag" SET "status" = CASE WHEN "enabled" THEN 'enabled' ELSE 'disabled' END WHERE "status" IS NULL;
        UPDATE "FeatureFlag" SET "createdAt" = "updatedAt" WHERE "createdAt" IS NULL;
        ALTER TABLE "FeatureFlag" ALTER COLUMN "status" SET NOT NULL;
        ALTER TABLE "FeatureFlag" ALTER COLUMN "createdAt" SET NOT NULL;
        ALTER TABLE "FeatureFlag" ALTER COLUMN "createdAt" SET DEFAULT now();
        ALTER TABLE "FeatureFlag" ALTER COLUMN "status" SET DEFAULT 'disabled';

        ALTER TABLE "FeatureFlag" DROP CONSTRAINT IF EXISTS "FeatureFlag_status_check";
        ALTER TABLE "FeatureFlag" ADD CONSTRAINT "FeatureFlag_status_check"
          CHECK ("status" IN ('enabled', 'disabled', 'killed', 'archived'));
        UPDATE "FeatureFlag" SET "bucketBy" = 'userId' WHERE "bucketBy" NOT IN ('userId', 'shopId');
        ALTER TABLE "FeatureFlag" DROP CONSTRAINT IF EXISTS "FeatureFlag_bucketBy_check";
        ALTER TABLE "FeatureFlag" ADD CONSTRAINT "FeatureFlag_bucketBy_check"
          CHECK ("bucketBy" IN ('userId', 'shopId'));
        CREATE INDEX IF NOT EXISTS "FeatureFlag_live_key_idx" ON "FeatureFlag" ("key") WHERE "status" <> 'archived';

        CREATE TABLE IF NOT EXISTS "FlagRuleset" (
          "id" SMALLINT PRIMARY KEY CHECK ("id" = 1),
          "version" BIGINT NOT NULL
        );
        INSERT INTO "FlagRuleset" ("id", "version")
          SELECT 1, GREATEST(COALESCE((SELECT max("version") FROM "FeatureFlag"), 1), 1)
          ON CONFLICT ("id") DO NOTHING;

        ALTER TABLE "FlagAudit" ADD COLUMN IF NOT EXISTS "requestId" TEXT NULL;
        UPDATE "FlagAudit" SET "actorId" = '00000000-0000-0000-0000-000000000000' WHERE "actorId" IS NULL;
        ALTER TABLE "FlagAudit" ALTER COLUMN "actorId" SET NOT NULL;
        CREATE INDEX IF NOT EXISTS "FlagAudit_flag_keyset_idx" ON "FlagAudit" ("flagKey", "at" DESC, "id" DESC);
        `,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';
        DROP INDEX IF EXISTS "FlagAudit_flag_keyset_idx";
        ALTER TABLE "FlagAudit" ALTER COLUMN "actorId" DROP NOT NULL;
        ALTER TABLE "FlagAudit" DROP COLUMN IF EXISTS "requestId";
        DROP TABLE IF EXISTS "FlagRuleset";
        DROP INDEX IF EXISTS "FeatureFlag_live_key_idx";
        ALTER TABLE "FeatureFlag" DROP CONSTRAINT IF EXISTS "FeatureFlag_bucketBy_check";
        ALTER TABLE "FeatureFlag" DROP CONSTRAINT IF EXISTS "FeatureFlag_status_check";
        ALTER TABLE "FeatureFlag" DROP COLUMN IF EXISTS "createdAt";
        ALTER TABLE "FeatureFlag" DROP COLUMN IF EXISTS "status";
        `,
        { transaction },
      );
    });
  },
};
