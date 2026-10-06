'use strict';

/**
 * SD-35 competitor price monitor. Many shops can watch the SAME page:
 * `CrawlTarget` is the unit we fetch (one fetch per normalized URL per
 * cycle), `CompetitorWatch` links a shop's product to a target.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "CrawlTarget" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "url" TEXT NOT NULL UNIQUE,
        "host" TEXT NOT NULL,
        "lastPriceMinor" BIGINT NULL,
        "currency" TEXT NULL,
        "simhash" TEXT NULL,
        "unchangedStreak" INTEGER NOT NULL DEFAULT 0,
        "lastStatus" TEXT NULL,
        "lastCheckedAt" TIMESTAMPTZ NULL,
        "nextCheckAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "CrawlTarget_due_idx" ON "CrawlTarget" ("nextCheckAt");

      CREATE TABLE IF NOT EXISTS "CompetitorWatch" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "productId" UUID NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
        "targetId" UUID NOT NULL REFERENCES "CrawlTarget"("id"),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE ("productId", "targetId")
      );
      CREATE INDEX IF NOT EXISTS "CompetitorWatch_target_idx" ON "CompetitorWatch" ("targetId");
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "CompetitorWatch", "CrawlTarget"`);
  },
};
