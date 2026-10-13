'use strict';

/**
 * S36 sponsored listings, expand step (III.11, never run at application start; specs/domains/S36-sponsored-listings
 * data-model.md). Backward compatible: the old money columns stay (relaxed to nullable so the new code, which writes the
 * `...Minor` columns only, can insert), the new columns are backfilled from them, and nothing is renamed or dropped.
 * New: `AdCampaign` money/status/version columns with CHECKs and the one-open-campaign-per-product index; the history,
 * sponsorship, quota, snapshot, adjustment and reconciliation tables; the `AdBillingRun` state/source/reference columns.
 * The cross-owner foreign keys are dropped by the next migration (own step, L7).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);

      // ---- AdCampaign ----------------------------------------------------------------------------------------------
      await q(`
        ALTER TABLE "AdCampaign"
          ADD COLUMN IF NOT EXISTS "cpcMinor" INTEGER NULL,
          ADD COLUMN IF NOT EXISTS "dailyBudgetMinor" INTEGER NULL,
          ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'EUR',
          ADD COLUMN IF NOT EXISTS "statusReason" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "campaignVersion" INTEGER NOT NULL DEFAULT 1,
          ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      `);
      // Backfill once; a row that cannot satisfy the new range checks is clamped (none expected outside a sandbox).
      await q(`
        UPDATE "AdCampaign" SET
          "cpcMinor" = LEAST(GREATEST("cpcCents", 1), 10000)
        WHERE "cpcMinor" IS NULL AND "cpcCents" IS NOT NULL
      `);
      await q(`
        UPDATE "AdCampaign" SET
          "dailyBudgetMinor" = LEAST(GREATEST("dailyBudgetCents", 100, "cpcMinor"), 10000000)
        WHERE "dailyBudgetMinor" IS NULL AND "dailyBudgetCents" IS NOT NULL
      `);
      await q(`ALTER TABLE "AdCampaign" ALTER COLUMN "cpcCents" DROP NOT NULL`);
      await q(
        `ALTER TABLE "AdCampaign" ALTER COLUMN "dailyBudgetCents" DROP NOT NULL`,
      );
      await q(`ALTER TABLE "AdCampaign" ALTER COLUMN "cpcMinor" SET NOT NULL`);
      await q(
        `ALTER TABLE "AdCampaign" ALTER COLUMN "dailyBudgetMinor" SET NOT NULL`,
      );
      await q(`ALTER TABLE "AdCampaign" DROP CONSTRAINT IF EXISTS "AdCampaign_status_check"`);
      await q(
        `ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED', 'ENDED'))`,
      );
      for (const [name, check] of [
        ['AdCampaign_cpc_minor_check', `"cpcMinor" BETWEEN 1 AND 10000`],
        [
          'AdCampaign_budget_minor_check',
          `"dailyBudgetMinor" BETWEEN 100 AND 10000000 AND "dailyBudgetMinor" >= "cpcMinor"`,
        ],
        ['AdCampaign_currency_check', `"currency" = 'EUR'`],
        [
          'AdCampaign_status_reason_check',
          `"statusReason" IS NULL OR "statusReason" IN ('seller', 'product_unavailable')`,
        ],
      ]) {
        await q(`ALTER TABLE "AdCampaign" DROP CONSTRAINT IF EXISTS "${name}"`);
        await q(`ALTER TABLE "AdCampaign" ADD CONSTRAINT "${name}" CHECK (${check})`);
      }
      // Older duplicates of an open product end, so the unique index below can be built.
      await q(`
        UPDATE "AdCampaign" a SET "status" = 'ENDED', "statusReason" = 'seller', "updatedAt" = now()
        WHERE a."status" <> 'ENDED' AND EXISTS (
          SELECT 1 FROM "AdCampaign" b
          WHERE b."productId" = a."productId" AND b."status" <> 'ENDED'
            AND (b."createdAt", b."id") > (a."createdAt", a."id"))
      `);
      await q(`
        CREATE UNIQUE INDEX IF NOT EXISTS "AdCampaign_open_product_uq"
          ON "AdCampaign" ("productId") WHERE "status" <> 'ENDED';
        CREATE INDEX IF NOT EXISTS "AdCampaign_shop_list_idx"
          ON "AdCampaign" ("shopId", "createdAt" DESC, "id" DESC);
        CREATE INDEX IF NOT EXISTS "AdCampaign_serve_idx"
          ON "AdCampaign" ("category", "cpcMinor" DESC, "id") WHERE "status" = 'ACTIVE';
      `);

      // ---- history, sponsorship, quota ------------------------------------------------------------------------------
      await q(`
        CREATE TABLE IF NOT EXISTS "AdCampaignHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "campaignId" UUID NOT NULL REFERENCES "AdCampaign"("id"),
          "actorId" UUID NULL,
          "fromStatus" TEXT NULL CHECK ("fromStatus" IN ('ACTIVE', 'PAUSED', 'ENDED')),
          "toStatus" TEXT NOT NULL CHECK ("toStatus" IN ('ACTIVE', 'PAUSED', 'ENDED')),
          "reason" TEXT NOT NULL,
          "campaignVersion" INTEGER NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT "AdCampaignHistory_version_uq" UNIQUE ("campaignId", "campaignVersion")
        );

        CREATE TABLE IF NOT EXISTS "AdProductSponsorship" (
          "productId" UUID PRIMARY KEY,
          "shopId" UUID NOT NULL,
          "sponsored" BOOLEAN NOT NULL,
          "sponsorshipVersion" INTEGER NOT NULL CHECK ("sponsorshipVersion" >= 1),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS "AdShopQuota" (
          "shopId" UUID PRIMARY KEY,
          "openCount" INTEGER NOT NULL CHECK ("openCount" BETWEEN 0 AND 50)
        );
      `);
      // Existing open campaigns count against the quota (capped by the CHECK for a shop that already exceeds it).
      await q(`
        INSERT INTO "AdShopQuota" ("shopId", "openCount")
        SELECT "shopId", LEAST(COUNT(*), 50) FROM "AdCampaign" WHERE "status" <> 'ENDED' GROUP BY "shopId"
        ON CONFLICT ("shopId") DO NOTHING
      `);
      await q(`
        INSERT INTO "AdProductSponsorship" ("productId", "shopId", "sponsored", "sponsorshipVersion")
        SELECT "productId", "shopId", ("status" = 'ACTIVE'), 1 FROM "AdCampaign" WHERE "status" <> 'ENDED'
        ON CONFLICT ("productId") DO NOTHING
      `);

      // ---- read models ----------------------------------------------------------------------------------------------
      await q(`
        CREATE TABLE IF NOT EXISTS "AdProductSnapshot" (
          "productId" UUID PRIMARY KEY,
          "shopId" UUID NOT NULL,
          "title" TEXT NOT NULL,
          "category" TEXT NOT NULL,
          "priceMinor" INTEGER NOT NULL,
          "currency" TEXT NOT NULL,
          "inStock" BOOLEAN NOT NULL,
          "status" TEXT NOT NULL,
          "isSandbox" BOOLEAN NOT NULL,
          "productVersion" INTEGER NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "AdProductSnapshot_shop_idx" ON "AdProductSnapshot" ("shopId");

        CREATE TABLE IF NOT EXISTS "AdShopSnapshot" (
          "shopId" UUID PRIMARY KEY,
          "status" TEXT NOT NULL,
          "offboarding" BOOLEAN NOT NULL DEFAULT FALSE,
          "deleted" BOOLEAN NOT NULL DEFAULT FALSE,
          "shopVersion" INTEGER NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      // ---- billing --------------------------------------------------------------------------------------------------
      await q(`
        ALTER TABLE "AdBillingRun"
          ADD COLUMN IF NOT EXISTS "state" TEXT NOT NULL DEFAULT 'CHARGED',
          ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'stream',
          ADD COLUMN IF NOT EXISTS "billableClicks" INTEGER NULL,
          ADD COLUMN IF NOT EXISTS "cappedClicks" INTEGER NULL,
          ADD COLUMN IF NOT EXISTS "amountMinor" BIGINT NULL,
          ADD COLUMN IF NOT EXISTS "ledgerReference" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "chargedAt" TIMESTAMPTZ NULL
      `);
      await q(`
        UPDATE "AdBillingRun" SET
          "billableClicks" = COALESCE("billableClicks", "clicks"),
          "cappedClicks" = COALESCE("cappedClicks", 0),
          "amountMinor" = COALESCE("amountMinor", "amountCents"),
          "ledgerReference" = COALESCE("ledgerReference",
            'ad:' || "campaignId"::text || ':' || to_char("hour" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24')),
          "chargedAt" = COALESCE("chargedAt", "createdAt")
      `);
      await q(`ALTER TABLE "AdBillingRun" ALTER COLUMN "amountMinor" SET NOT NULL`);
      await q(`ALTER TABLE "AdBillingRun" ALTER COLUMN "billableClicks" SET NOT NULL`);
      await q(`ALTER TABLE "AdBillingRun" ALTER COLUMN "cappedClicks" SET NOT NULL`);
      await q(`ALTER TABLE "AdBillingRun" ALTER COLUMN "ledgerReference" SET NOT NULL`);
      await q(`ALTER TABLE "AdBillingRun" ALTER COLUMN "amountCents" DROP NOT NULL`);
      await q(`ALTER TABLE "AdBillingRun" ALTER COLUMN "journalId" DROP NOT NULL`);
      for (const [name, check] of [
        ['AdBillingRun_state_check', `"state" IN ('PENDING', 'CHARGED')`],
        ['AdBillingRun_source_check', `"source" IN ('stream', 'reconciliation')`],
        [
          'AdBillingRun_amount_check',
          `"state" = 'CHARGED' OR "amountMinor" >= 0`,
        ],
      ]) {
        await q(`ALTER TABLE "AdBillingRun" DROP CONSTRAINT IF EXISTS "${name}"`);
        await q(`ALTER TABLE "AdBillingRun" ADD CONSTRAINT "${name}" CHECK (${check})`);
      }
      await q(
        `CREATE UNIQUE INDEX IF NOT EXISTS "AdBillingRun_reference_uq" ON "AdBillingRun" ("ledgerReference")`,
      );

      await q(`
        CREATE TABLE IF NOT EXISTS "AdReconciliationRun" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "day" DATE NOT NULL,
          "status" TEXT NOT NULL CHECK ("status" IN ('RUNNING', 'COMPLETED', 'FAILED')),
          "reason" TEXT NULL,
          "hoursChecked" INTEGER NOT NULL DEFAULT 0,
          "hoursAdjusted" INTEGER NOT NULL DEFAULT 0,
          "netDeltaMinor" BIGINT NOT NULL DEFAULT 0,
          "driftRatio" NUMERIC(8, 6) NULL,
          "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "finishedAt" TIMESTAMPTZ NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "AdReconciliationRun_running_uq"
          ON "AdReconciliationRun" ("day") WHERE "status" = 'RUNNING';

        CREATE TABLE IF NOT EXISTS "AdBillingAdjustment" (
          "campaignId" UUID NOT NULL,
          "hour" TIMESTAMPTZ NOT NULL,
          "sequence" INTEGER NOT NULL CHECK ("sequence" >= 1),
          "deltaClicks" INTEGER NOT NULL,
          "deltaMinor" BIGINT NOT NULL CHECK ("deltaMinor" <> 0),
          "ledgerReference" TEXT NOT NULL,
          "state" TEXT NOT NULL CHECK ("state" IN ('PENDING', 'POSTED')),
          "journalId" UUID NULL,
          "reconciliationRunId" UUID NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "postedAt" TIMESTAMPTZ NULL,
          PRIMARY KEY ("campaignId", "hour", "sequence"),
          CONSTRAINT "AdBillingAdjustment_run_fk" FOREIGN KEY ("campaignId", "hour")
            REFERENCES "AdBillingRun"("campaignId", "hour"),
          CONSTRAINT "AdBillingAdjustment_reference_uq" UNIQUE ("ledgerReference")
        );
      `);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        DROP TABLE IF EXISTS "AdBillingAdjustment";
        DROP TABLE IF EXISTS "AdReconciliationRun";
        DROP TABLE IF EXISTS "AdShopSnapshot";
        DROP TABLE IF EXISTS "AdProductSnapshot";
        DROP TABLE IF EXISTS "AdShopQuota";
        DROP TABLE IF EXISTS "AdProductSponsorship";
        DROP TABLE IF EXISTS "AdCampaignHistory";
      `);
      await q(`DROP INDEX IF EXISTS "AdBillingRun_reference_uq"`);
      await q(`
        UPDATE "AdBillingRun" SET "amountCents" = COALESCE("amountCents", "amountMinor"),
          "journalId" = COALESCE("journalId", uuidv7())
      `);
      await q(`
        ALTER TABLE "AdBillingRun"
          DROP CONSTRAINT IF EXISTS "AdBillingRun_state_check",
          DROP CONSTRAINT IF EXISTS "AdBillingRun_source_check",
          DROP CONSTRAINT IF EXISTS "AdBillingRun_amount_check",
          DROP COLUMN IF EXISTS "state",
          DROP COLUMN IF EXISTS "source",
          DROP COLUMN IF EXISTS "billableClicks",
          DROP COLUMN IF EXISTS "cappedClicks",
          DROP COLUMN IF EXISTS "amountMinor",
          DROP COLUMN IF EXISTS "ledgerReference",
          DROP COLUMN IF EXISTS "chargedAt",
          ALTER COLUMN "amountCents" SET NOT NULL,
          ALTER COLUMN "journalId" SET NOT NULL
      `);
      await q(`
        DROP INDEX IF EXISTS "AdCampaign_serve_idx";
        DROP INDEX IF EXISTS "AdCampaign_shop_list_idx";
        DROP INDEX IF EXISTS "AdCampaign_open_product_uq";
      `);
      await q(`
        UPDATE "AdCampaign" SET "cpcCents" = COALESCE("cpcCents", "cpcMinor"),
          "dailyBudgetCents" = COALESCE("dailyBudgetCents", "dailyBudgetMinor"),
          "status" = CASE WHEN "status" = 'ENDED' THEN 'PAUSED' ELSE "status" END
      `);
      await q(`
        ALTER TABLE "AdCampaign"
          DROP CONSTRAINT IF EXISTS "AdCampaign_cpc_minor_check",
          DROP CONSTRAINT IF EXISTS "AdCampaign_budget_minor_check",
          DROP CONSTRAINT IF EXISTS "AdCampaign_currency_check",
          DROP CONSTRAINT IF EXISTS "AdCampaign_status_reason_check",
          DROP CONSTRAINT IF EXISTS "AdCampaign_status_check",
          DROP COLUMN IF EXISTS "cpcMinor",
          DROP COLUMN IF EXISTS "dailyBudgetMinor",
          DROP COLUMN IF EXISTS "currency",
          DROP COLUMN IF EXISTS "statusReason",
          DROP COLUMN IF EXISTS "campaignVersion",
          DROP COLUMN IF EXISTS "updatedAt",
          ALTER COLUMN "cpcCents" SET NOT NULL,
          ALTER COLUMN "dailyBudgetCents" SET NOT NULL
      `);
      await q(
        `ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED'))`,
      );
    });
  },
};
