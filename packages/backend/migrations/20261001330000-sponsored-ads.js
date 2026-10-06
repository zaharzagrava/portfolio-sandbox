'use strict';

/**
 * SD-32 sponsored listings. Billing runs are keyed by (campaign, hour): the
 * hourly job can run twice (retry, overlap) and still charge once.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "AdCampaign" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "productId" UUID NOT NULL REFERENCES "Product"("id"),
        "category" TEXT NOT NULL,
        "cpcCents" INTEGER NOT NULL CHECK ("cpcCents" > 0),
        "dailyBudgetCents" INTEGER NOT NULL CHECK ("dailyBudgetCents" > 0),
        "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'PAUSED')),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "AdCampaign_active_idx" ON "AdCampaign" ("category", "cpcCents" DESC) WHERE status = 'ACTIVE';

      CREATE TABLE IF NOT EXISTS "AdBillingRun" (
        "campaignId" UUID NOT NULL REFERENCES "AdCampaign"("id"),
        "hour" TIMESTAMPTZ NOT NULL,
        "clicks" INTEGER NOT NULL,
        "amountCents" BIGINT NOT NULL,
        "journalId" UUID NOT NULL,
        "reconciledClicks" INTEGER NULL,
        "adjustmentJournalId" UUID NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("campaignId", "hour")
      );
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "AdBillingRun", "AdCampaign"`);
  },
};
