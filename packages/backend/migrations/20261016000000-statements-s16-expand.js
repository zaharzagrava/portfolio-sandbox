'use strict';

/**
 * S16 seller statements, expand step (III.11, IX.4; specs/domains/S16-seller-statements/data-model.md). Additive and
 * idempotent: every statement is `IF NOT EXISTS` or guarded by the catalog, so running it twice changes nothing
 * (AS-78). Legacy columns (`gross`, `commission`, `net`, `lines`, `commissionDelta`) stay; the API renames them.
 *
 *  - `CommissionRate`: `changeId`, `recordedBy`, lower-cased category, a reason check for new rows, a history index;
 *  - `AccountingPeriod`: status widened to OPEN|CLOSING|CLOSED, `knowledgeCutoff`, `shopCount`, `runId`;
 *  - `StatementSnapshot`: `knowledgeCutoff` (backfill `computedAt`), payouts and adjustment totals, `runId`;
 *  - `StatementAdjustment`: cause kind and reference (backfill `rate_change` / `legacy:<reason>`), the four deltas, a
 *    new unique key. The old UNIQUE(shopId, refersToMonth, reason) is dropped here and not in the contract step: it
 *    would refuse AS-42 (two changes with the same reason text), and the only writer that relied on it is replaced in
 *    the same release;
 *  - eight new tables (facts, watermarks, runs, history, findings) with no foreign key to another domain;
 *  - three guard triggers that make closed money immutable at the store (AS-34, AS-37).
 *
 * Backfills run before the guards exist and only when their column is added, so a second run never rewrites a row.
 */
const ZERO = '00000000-0000-0000-0000-000000000000';

/** Runs `body` only when `column` does not exist yet (the DO block adds the column and backfills inside it). */
const whenColumnMissing = (table, column, body) => `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = '${table}' AND column_name = '${column}') THEN
      ${body}
    END IF;
  END $$;`;

const DDL = [
  `SET LOCAL lock_timeout = '5s'`,

  // ---- CommissionRate --------------------------------------------------------------------------------------------
  `ALTER TABLE "CommissionRate" ADD COLUMN IF NOT EXISTS "changeId" UUID`,
  `UPDATE "CommissionRate" SET "changeId" = "id" WHERE "changeId" IS NULL`,
  `ALTER TABLE "CommissionRate" ALTER COLUMN "changeId" SET DEFAULT uuidv7()`,
  `ALTER TABLE "CommissionRate" ALTER COLUMN "changeId" SET NOT NULL`,
  `ALTER TABLE "CommissionRate" ADD COLUMN IF NOT EXISTS "recordedBy" UUID NULL`,
  `UPDATE "CommissionRate" SET "category" = lower(btrim("category")) WHERE "category" <> lower(btrim("category"))`,
  // NOT VALID: legacy rows keep their text; the application always sends a reason of 1 to 200 characters.
  `ALTER TABLE "CommissionRate" DROP CONSTRAINT IF EXISTS "CommissionRate_reason_len"`,
  `ALTER TABLE "CommissionRate" ADD CONSTRAINT "CommissionRate_reason_len"
     CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 200) NOT VALID`,
  `CREATE INDEX IF NOT EXISTS "CommissionRate_history" ON "CommissionRate" ((lower("recordedPeriod")) DESC, "id" DESC)`,
  `CREATE INDEX IF NOT EXISTS "CommissionRate_history_key" ON "CommissionRate" ("shopKey", "category", (lower("recordedPeriod")) DESC, "id" DESC)`,

  // ---- AccountingPeriod ------------------------------------------------------------------------------------------
  `DO $$
   DECLARE c record;
   BEGIN
     FOR c IN SELECT conname FROM pg_constraint
               WHERE conrelid = '"AccountingPeriod"'::regclass AND contype = 'c'
                 AND pg_get_constraintdef(oid) LIKE '%status%' AND conname <> 'AccountingPeriod_status_states' LOOP
       EXECUTE format('ALTER TABLE "AccountingPeriod" DROP CONSTRAINT %I', c.conname);
     END LOOP;
   END $$`,
  `ALTER TABLE "AccountingPeriod" DROP CONSTRAINT IF EXISTS "AccountingPeriod_status_states"`,
  `ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_status_states"
     CHECK ("status" IN ('OPEN','CLOSING','CLOSED'))`,
  whenColumnMissing(
    'AccountingPeriod',
    'knowledgeCutoff',
    `ALTER TABLE "AccountingPeriod" ADD COLUMN "knowledgeCutoff" TIMESTAMPTZ NULL;
     UPDATE "AccountingPeriod" SET "knowledgeCutoff" = "closedAt" WHERE "status" = 'CLOSED';`,
  ),
  `ALTER TABLE "AccountingPeriod" ADD COLUMN IF NOT EXISTS "shopCount" INTEGER NULL`,
  `ALTER TABLE "AccountingPeriod" ADD COLUMN IF NOT EXISTS "runId" UUID NULL`,

  // ---- StatementSnapshot -----------------------------------------------------------------------------------------
  whenColumnMissing(
    'StatementSnapshot',
    'knowledgeCutoff',
    `ALTER TABLE "StatementSnapshot" ADD COLUMN "knowledgeCutoff" TIMESTAMPTZ NOT NULL DEFAULT now();
     UPDATE "StatementSnapshot" SET "knowledgeCutoff" = "computedAt";`,
  ),
  `ALTER TABLE "StatementSnapshot" ADD COLUMN IF NOT EXISTS "payoutsPaidMinor" BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE "StatementSnapshot" ADD COLUMN IF NOT EXISTS "adjGrossMinor" BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE "StatementSnapshot" ADD COLUMN IF NOT EXISTS "adjCommissionMinor" BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE "StatementSnapshot" ADD COLUMN IF NOT EXISTS "adjLineCount" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "StatementSnapshot" ADD COLUMN IF NOT EXISTS "adjPayoutsMinor" BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE "StatementSnapshot" ADD COLUMN IF NOT EXISTS "runId" UUID NULL`,
  `CREATE INDEX IF NOT EXISTS "StatementSnapshot_month" ON "StatementSnapshot" ("month", "shopId")`,

  // ---- StatementAdjustment ---------------------------------------------------------------------------------------
  whenColumnMissing(
    'StatementAdjustment',
    'causeKind',
    `ALTER TABLE "StatementAdjustment" ADD COLUMN "causeKind" TEXT NULL;
     ALTER TABLE "StatementAdjustment" ADD COLUMN "causeRef" TEXT NULL;
     UPDATE "StatementAdjustment" SET "causeKind" = 'rate_change', "causeRef" = 'legacy:' || "reason";
     ALTER TABLE "StatementAdjustment" ALTER COLUMN "causeKind" SET NOT NULL;
     ALTER TABLE "StatementAdjustment" ALTER COLUMN "causeRef" SET NOT NULL;`,
  ),
  whenColumnMissing(
    'StatementAdjustment',
    'commissionDeltaMinor',
    `ALTER TABLE "StatementAdjustment" ADD COLUMN "commissionDeltaMinor" BIGINT NOT NULL DEFAULT 0;
     UPDATE "StatementAdjustment" SET "commissionDeltaMinor" = "commissionDelta";`,
  ),
  `ALTER TABLE "StatementAdjustment" ADD COLUMN IF NOT EXISTS "grossDeltaMinor" BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE "StatementAdjustment" ADD COLUMN IF NOT EXISTS "lineCountDelta" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "StatementAdjustment" ADD COLUMN IF NOT EXISTS "payoutsPaidDeltaMinor" BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE "StatementAdjustment" DROP CONSTRAINT IF EXISTS "StatementAdjustment_cause_kind"`,
  `ALTER TABLE "StatementAdjustment" ADD CONSTRAINT "StatementAdjustment_cause_kind"
     CHECK ("causeKind" IN ('rate_change','late_sale','late_payout'))`,
  `ALTER TABLE "StatementAdjustment" DROP CONSTRAINT IF EXISTS "StatementAdjustment_shopId_refersToMonth_reason_key"`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "StatementAdjustment_cause_uq"
     ON "StatementAdjustment" ("shopId", "refersToMonth", "causeKind", "causeRef")`,
  `CREATE INDEX IF NOT EXISTS "StatementAdjustment_booked" ON "StatementAdjustment" ("shopId", "bookedMonth")`,
  `CREATE INDEX IF NOT EXISTS "StatementAdjustment_refers" ON "StatementAdjustment" ("shopId", "refersToMonth")`,

  // ---- Facts (R3) ------------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS "StatementSaleFact" (
     "orderId" UUID NOT NULL,
     "lineId" TEXT NOT NULL,
     "orderVersion" INTEGER NOT NULL CHECK ("orderVersion" >= 1),
     "shopId" UUID NOT NULL,
     "productId" TEXT NOT NULL,
     "category" TEXT NOT NULL,
     "quantity" INTEGER NOT NULL CHECK ("quantity" >= 1),
     "unitPriceMinor" BIGINT NOT NULL CHECK ("unitPriceMinor" >= 0),
     "discountMinor" BIGINT NOT NULL CHECK ("discountMinor" >= 0),
     "lineTotalMinor" BIGINT NOT NULL,
     "paidAt" TIMESTAMPTZ NOT NULL,
     "recordedAt" TIMESTAMPTZ NOT NULL,
     "appliedAt" TIMESTAMPTZ NOT NULL,
     "eventId" UUID NOT NULL,
     PRIMARY KEY ("orderId", "lineId", "orderVersion"),
     CONSTRAINT "StatementSaleFact_total" CHECK ("lineTotalMinor" = "quantity" * "unitPriceMinor" - "discountMinor"),
     CONSTRAINT "StatementSaleFact_range" CHECK ("lineTotalMinor" BETWEEN 0 AND 1000000000000)
   )`,
  `CREATE INDEX IF NOT EXISTS "StatementSaleFact_shop_paid" ON "StatementSaleFact" ("shopId", "paidAt", "orderId", "lineId")`,
  `CREATE INDEX IF NOT EXISTS "StatementSaleFact_applied" ON "StatementSaleFact" ("appliedAt")`,

  `CREATE TABLE IF NOT EXISTS "StatementPayoutFact" (
     "payoutId" UUID PRIMARY KEY,
     "shopId" UUID NOT NULL,
     "amountMinor" BIGINT NOT NULL CHECK ("amountMinor" > 0),
     "paidAt" TIMESTAMPTZ NOT NULL,
     "payoutVersion" INTEGER NOT NULL CHECK ("payoutVersion" >= 1),
     "recordedAt" TIMESTAMPTZ NOT NULL,
     "appliedAt" TIMESTAMPTZ NOT NULL,
     "eventId" UUID NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS "StatementPayoutFact_shop_paid" ON "StatementPayoutFact" ("shopId", "paidAt")`,

  `CREATE TABLE IF NOT EXISTS "StatementLedgerFact" (
     "journalId" UUID PRIMARY KEY,
     "orderId" UUID NULL,
     "postedAt" TIMESTAMPTZ NOT NULL,
     "recordedAt" TIMESTAMPTZ NOT NULL,
     "appliedAt" TIMESTAMPTZ NOT NULL,
     "eventId" UUID NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS "StatementLedgerFact_order" ON "StatementLedgerFact" ("orderId")`,
  `CREATE TABLE IF NOT EXISTS "StatementLedgerCredit" (
     "journalId" UUID NOT NULL,
     "accountId" TEXT NOT NULL,
     "amountMinor" BIGINT NOT NULL CHECK ("amountMinor" > 0),
     PRIMARY KEY ("journalId", "accountId")
   )`,

  `CREATE TABLE IF NOT EXISTS "StatementStreamWatermark" (
     "stream" TEXT PRIMARY KEY CHECK ("stream" IN ('orders','payouts','ledger')),
     "appliedThrough" TIMESTAMPTZ NULL,
     "updatedAt" TIMESTAMPTZ NOT NULL
   )`,

  // ---- Runs, history, findings -----------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS "StatementPeriodRun" (
     "runId" UUID PRIMARY KEY,
     "month" DATE NOT NULL,
     "status" TEXT NOT NULL CHECK ("status" IN ('RUNNING','COMPLETED','FAILED')),
     "knowledgeCutoff" TIMESTAMPTZ NOT NULL,
     "failureCode" TEXT NULL,
     "details" JSONB NULL,
     "batchesWritten" INTEGER NOT NULL DEFAULT 0,
     "shopsWritten" INTEGER NOT NULL DEFAULT 0,
     "startedAt" TIMESTAMPTZ NOT NULL,
     "finishedAt" TIMESTAMPTZ NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "StatementPeriodRun_one_running" ON "StatementPeriodRun" ("month") WHERE "status" = 'RUNNING'`,
  `CREATE INDEX IF NOT EXISTS "StatementPeriodRun_month" ON "StatementPeriodRun" ("month", "startedAt" DESC)`,
  `CREATE TABLE IF NOT EXISTS "StatementPeriodHistory" (
     "id" UUID PRIMARY KEY DEFAULT uuidv7(),
     "month" DATE NOT NULL,
     "fromStatus" TEXT NOT NULL,
     "toStatus" TEXT NOT NULL,
     "runId" UUID NULL,
     "actor" TEXT NOT NULL,
     "at" TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS "StatementPeriodHistory_month" ON "StatementPeriodHistory" ("month", "at")`,
  `CREATE TABLE IF NOT EXISTS "StatementFinding" (
     "id" UUID PRIMARY KEY DEFAULT uuidv7(),
     "month" DATE NOT NULL,
     "kind" TEXT NOT NULL CHECK ("kind" IN ('net_mismatch','fee_mismatch','missing_in_ledger','missing_in_statement','completeness_violation')),
     "shopId" UUID NULL,
     "expectedMinor" BIGINT NOT NULL,
     "actualMinor" BIGINT NOT NULL,
     "differenceMinor" BIGINT NOT NULL,
     "status" TEXT NOT NULL CHECK ("status" IN ('OPEN','CLEARED')),
     "openedAt" TIMESTAMPTZ NOT NULL,
     "clearedAt" TIMESTAMPTZ NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "StatementFinding_key"
     ON "StatementFinding" ("month", "kind", (coalesce("shopId", '${ZERO}'::uuid)))`,
  `CREATE INDEX IF NOT EXISTS "StatementFinding_month" ON "StatementFinding" ("month", "openedAt" DESC, "id" DESC)`,

  // ---- Guards: closed money cannot change (AS-34, AS-37) ---------------------------------------------------------
  `CREATE OR REPLACE FUNCTION statements_period_guard() RETURNS trigger AS $fn$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'statements_immutable: accounting periods are never deleted';
     END IF;
     IF OLD."status" = 'CLOSED' THEN
       RAISE EXCEPTION 'statements_immutable: a closed accounting period never changes';
     END IF;
     IF NEW."month" <> OLD."month" THEN
       RAISE EXCEPTION 'statements_immutable: the month of a period never changes';
     END IF;
     IF NEW."status" <> OLD."status" AND NOT (
          (OLD."status" = 'OPEN' AND NEW."status" = 'CLOSING') OR
          (OLD."status" = 'CLOSING' AND NEW."status" IN ('CLOSED','OPEN'))) THEN
       RAISE EXCEPTION 'statements_immutable: transition % -> % is not allowed', OLD."status", NEW."status";
     END IF;
     RETURN NEW;
   END
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS statements_period_guard ON "AccountingPeriod"`,
  `CREATE TRIGGER statements_period_guard BEFORE UPDATE OR DELETE ON "AccountingPeriod"
     FOR EACH ROW EXECUTE FUNCTION statements_period_guard()`,

  `CREATE OR REPLACE FUNCTION statements_snapshot_guard() RETURNS trigger AS $fn$
   BEGIN
     IF TG_OP = 'UPDATE' THEN
       RAISE EXCEPTION 'statements_immutable: snapshots are never updated';
     END IF;
     IF EXISTS (SELECT 1 FROM "AccountingPeriod" WHERE "month" = OLD."month" AND "status" = 'CLOSED') THEN
       RAISE EXCEPTION 'statements_immutable: a snapshot of a closed month is never deleted';
     END IF;
     RETURN OLD;
   END
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS statements_snapshot_guard ON "StatementSnapshot"`,
  `CREATE TRIGGER statements_snapshot_guard BEFORE UPDATE OR DELETE ON "StatementSnapshot"
     FOR EACH ROW EXECUTE FUNCTION statements_snapshot_guard()`,

  `CREATE OR REPLACE FUNCTION statements_adjustment_guard() RETURNS trigger AS $fn$
   BEGIN
     RAISE EXCEPTION 'statements_immutable: adjustments are never updated or deleted';
   END
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS statements_adjustment_guard ON "StatementAdjustment"`,
  `CREATE TRIGGER statements_adjustment_guard BEFORE UPDATE OR DELETE ON "StatementAdjustment"
     FOR EACH ROW EXECUTE FUNCTION statements_adjustment_guard()`,
];

module.exports = {
  DDL,
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const sql of DDL) {
        await queryInterface.sequelize.query(sql, { transaction });
      }
    });
  },
  async down(queryInterface) {
    // Additions only; the legacy shape is untouched. The old unique key is not restored (see the header).
    await queryInterface.sequelize.transaction(async (transaction) => {
      const sql = (text) => queryInterface.sequelize.query(text, { transaction });
      await sql(`DROP TRIGGER IF EXISTS statements_adjustment_guard ON "StatementAdjustment"`);
      await sql(`DROP TRIGGER IF EXISTS statements_snapshot_guard ON "StatementSnapshot"`);
      await sql(`DROP TRIGGER IF EXISTS statements_period_guard ON "AccountingPeriod"`);
      await sql(`DROP FUNCTION IF EXISTS statements_adjustment_guard(), statements_snapshot_guard(), statements_period_guard()`);
      await sql(`DROP TABLE IF EXISTS "StatementFinding", "StatementPeriodHistory", "StatementPeriodRun",
        "StatementStreamWatermark", "StatementLedgerCredit", "StatementLedgerFact", "StatementPayoutFact", "StatementSaleFact"`);
    });
  },
};
