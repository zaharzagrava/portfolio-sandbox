'use strict';

/**
 * SD-41 seller statements & "as-of" reporting.
 *
 * CommissionRate is BITEMPORAL (lesson 03/03 §7, 10/02 Ex5):
 *   valid_period    - when the rate applies in the business world
 *   recorded_period - when we believed it (history is never updated in place:
 *                     a correction closes the old row's recorded_period and inserts new rows)
 * The exclusion constraint forbids two CURRENT-knowledge rows with overlapping
 * validity for the same (shop, category) - no ambiguous rates, enforced by the DB.
 * Months are closed into snapshots; later corrections become adjustment rows in
 * the open month, so a closed statement never silently changes.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        CREATE TABLE IF NOT EXISTS "CommissionRate" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopKey" UUID NOT NULL,              -- shop id, or the all-zero uuid for the marketplace default
          "category" TEXT NOT NULL,
          "rateBps" INTEGER NOT NULL CHECK ("rateBps" BETWEEN 0 AND 10000),
          "validPeriod" TSTZRANGE NOT NULL,
          "recordedPeriod" TSTZRANGE NOT NULL DEFAULT tstzrange(now(), NULL),
          "reason" TEXT NULL,
          CONSTRAINT "CommissionRate_no_overlap_current" EXCLUDE USING gist (
            "shopKey" WITH =, "category" WITH =, "validPeriod" WITH &&
          ) WHERE (upper_inf("recordedPeriod"))
        );
        CREATE INDEX IF NOT EXISTS "CommissionRate_lookup" ON "CommissionRate" USING gist ("shopKey", "category", "validPeriod", "recordedPeriod");

        CREATE TABLE IF NOT EXISTS "AccountingPeriod" (
          "month" DATE PRIMARY KEY,
          "status" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN','CLOSED')),
          "closedAt" TIMESTAMPTZ NULL
        );

        CREATE TABLE IF NOT EXISTS "StatementSnapshot" (
          "shopId" UUID NOT NULL,
          "month" DATE NOT NULL,
          "gross" BIGINT NOT NULL,
          "commission" BIGINT NOT NULL,
          "net" BIGINT NOT NULL,
          "lines" INTEGER NOT NULL,
          "computedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("shopId", "month")
        );

        CREATE TABLE IF NOT EXISTS "StatementAdjustment" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopId" UUID NOT NULL,
          "bookedMonth" DATE NOT NULL,
          "refersToMonth" DATE NOT NULL,
          "commissionDelta" BIGINT NOT NULL,
          "reason" TEXT NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE ("shopId", "refersToMonth", "reason")
        );

        -- Marketplace default: 10% for every category from the beginning of time.
        INSERT INTO "CommissionRate" ("shopKey", category, "rateBps", "validPeriod", "recordedPeriod", reason)
        VALUES ('00000000-0000-0000-0000-000000000000', '*', 1000, tstzrange('-infinity', NULL), tstzrange('-infinity', NULL), 'initial default');
        `,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "StatementAdjustment", "StatementSnapshot", "AccountingPeriod", "CommissionRate"`);
  },
};
