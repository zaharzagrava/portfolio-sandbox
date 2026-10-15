'use strict';

/**
 * S18 usage settlement ledger, expand step (III.11, IX.4; specs/domains/S18-usage-entitlements/data-model.md).
 * Additive and idempotent: `IF NOT EXISTS` and `CREATE OR REPLACE`, so a second run changes nothing. One short
 * transaction with `SET LOCAL lock_timeout`; nothing here rewrites an existing table.
 *
 *  - `UsageSettlement`: one row per `(subscription, periodStart, metric)` holding what was billed for the usage of a
 *    period: the settled quantity and amount, the allowance and rate snapshot of the period, the last invoice, and a
 *    `closed` flag. Settled values only move forward (trigger `usage_settlement_forward_only`).
 *
 * The rows for invoices issued by the previous implementation are built by the repeatable script
 * `scripts/backfill-usage-settlement.ts` (it needs the usage store, which is not Postgres).
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;
const SAFE_INTEGER = '9007199254740991';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "UsageSettlement" (
     "id" UUID PRIMARY KEY DEFAULT uuidv7(),
     "subscriptionId" UUID NOT NULL REFERENCES "Subscription"("id"),
     "periodStart" TIMESTAMPTZ NOT NULL,
     "periodEnd" TIMESTAMPTZ NOT NULL,
     "metric" TEXT NOT NULL CHECK ("metric" ~ '^(api\\.calls|llm\\.[a-z][a-z_]{0,31}\\.tokens)$'),
     "settledQuantity" BIGINT NOT NULL,
     "settledAmountMinor" BIGINT NOT NULL,
     "includedQuantity" BIGINT NOT NULL,
     "overagePer1000Minor" BIGINT NOT NULL,
     "lastInvoiceId" UUID NOT NULL REFERENCES "Invoice"("id"),
     "closed" BOOLEAN NOT NULL DEFAULT FALSE,
     "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
     "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT "UsageSettlement_period_valid" CHECK ("periodEnd" > "periodStart"),
     CONSTRAINT "UsageSettlement_settled_range" CHECK (
       "settledQuantity" >= 0 AND "settledQuantity" <= ${SAFE_INTEGER} AND "settledAmountMinor" >= 0
       AND "settledAmountMinor" <= ${SAFE_INTEGER}),
     CONSTRAINT "UsageSettlement_snapshot_range" CHECK (
       "includedQuantity" >= 0 AND "overagePer1000Minor" >= 0)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "UsageSettlement_period_uq" ON "UsageSettlement" ("subscriptionId", "periodStart", "metric")`,
  `CREATE INDEX IF NOT EXISTS "UsageSettlement_open_idx" ON "UsageSettlement" ("subscriptionId") WHERE "closed" = FALSE`,
  `CREATE INDEX IF NOT EXISTS "UsageSettlement_open_scan_idx" ON "UsageSettlement" ("id") WHERE "closed" = FALSE`,
  `CREATE OR REPLACE FUNCTION usage_settlement_forward_only() RETURNS trigger AS $fn$
   BEGIN
     IF NEW."settledQuantity" < OLD."settledQuantity" OR NEW."settledAmountMinor" < OLD."settledAmountMinor" THEN
       RAISE EXCEPTION 'usage_settlement_forward_only: settled values never decrease';
     END IF;
     IF NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId" OR NEW."metric" IS DISTINCT FROM OLD."metric"
        OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart" OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
        OR NEW."includedQuantity" IS DISTINCT FROM OLD."includedQuantity"
        OR NEW."overagePer1000Minor" IS DISTINCT FROM OLD."overagePer1000Minor" THEN
       RAISE EXCEPTION 'usage_settlement_forward_only: the period and its snapshot never change';
     END IF;
     IF OLD."closed" AND NOT NEW."closed" THEN
       RAISE EXCEPTION 'usage_settlement_forward_only: a closed period is never reopened';
     END IF;
     RETURN NEW;
   END
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS usage_settlement_forward_only ON "UsageSettlement"`,
  `CREATE TRIGGER usage_settlement_forward_only BEFORE UPDATE ON "UsageSettlement"
     FOR EACH ROW EXECUTE FUNCTION usage_settlement_forward_only()`,
];

module.exports = {
  STATEMENTS,
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(LOCK_TIMEOUT, { transaction });
      for (const sql of STATEMENTS) {
        await queryInterface.sequelize.query(sql, { transaction });
      }
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "UsageSettlement"`);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS usage_settlement_forward_only()`);
  },
};
