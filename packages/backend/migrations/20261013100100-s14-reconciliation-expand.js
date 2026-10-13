'use strict';

/**
 * S14 payments, expand step 2: the reconciliation run gains a status, a lease and counts; the issue gains a state, a
 * resolution, the day it belongs to and a link to its adjustment; three new insert-only/technical tables hold the
 * issue history, the issues collected during a run (promoted in one transaction) and the references seen.
 * `STATUS_MISMATCH` stays allowed until the contract step (no row has it).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);

      // Existing runs are finished ones ('COMPLETED'); a run that never finished is a restartable failure.
      await q(`
        ALTER TABLE "ReconciliationRun" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'COMPLETED';
        ALTER TABLE "ReconciliationRun" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now();
        ALTER TABLE "ReconciliationRun" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMPTZ NULL;
        ALTER TABLE "ReconciliationRun" ADD COLUMN IF NOT EXISTS "failureCode" TEXT NULL;
        ALTER TABLE "ReconciliationRun" ADD COLUMN IF NOT EXISTS "providerLines" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "ReconciliationRun" ADD COLUMN IF NOT EXISTS "ledgerJournals" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "ReconciliationRun" ADD COLUMN IF NOT EXISTS "skipped" INTEGER NOT NULL DEFAULT 0;
        UPDATE "ReconciliationRun" SET "status" = 'FAILED', "failureCode" = 'interrupted' WHERE "finishedAt" IS NULL;
        ALTER TABLE "ReconciliationRun" ALTER COLUMN "status" SET DEFAULT 'RUNNING';
        ALTER TABLE "ReconciliationRun" DROP CONSTRAINT IF EXISTS "ReconciliationRun_status_check";
        ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_status_check"
          CHECK ("status" IN ('RUNNING','COMPLETED','FAILED'));
        ALTER TABLE "ReconciliationRun" DROP CONSTRAINT IF EXISTS "ReconciliationRun_failureCode_check";
        ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_failureCode_check"
          CHECK ("failureCode" IS NULL OR "failureCode" IN ('provider_unavailable','interrupted','internal'));
      `);

      await q(`
        ALTER TABLE "ReconciliationIssue" ADD COLUMN IF NOT EXISTS "day" DATE NULL;
        ALTER TABLE "ReconciliationIssue" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'OPEN';
        ALTER TABLE "ReconciliationIssue" ADD COLUMN IF NOT EXISTS "resolution" TEXT NULL;
        ALTER TABLE "ReconciliationIssue" ADD COLUMN IF NOT EXISTS "note" TEXT NULL;
        ALTER TABLE "ReconciliationIssue" ADD COLUMN IF NOT EXISTS "resolvedBy" TEXT NULL;
        ALTER TABLE "ReconciliationIssue" ADD COLUMN IF NOT EXISTS "adjustmentJournalId" UUID NULL;
        UPDATE "ReconciliationIssue" i SET "day" = r."day" FROM "ReconciliationRun" r WHERE r."id" = i."runId" AND i."day" IS NULL;
        UPDATE "ReconciliationIssue" SET "status" = 'RESOLVED', "resolution" = 'explained', "resolvedBy" = 'legacy'
          WHERE "resolvedAt" IS NOT NULL AND "status" = 'OPEN';
        ALTER TABLE "ReconciliationIssue" ALTER COLUMN "day" SET NOT NULL;
        ALTER TABLE "ReconciliationIssue" DROP CONSTRAINT IF EXISTS "ReconciliationIssue_kind_check";
        ALTER TABLE "ReconciliationIssue" DROP CONSTRAINT IF EXISTS "ReconciliationIssue_kind_s14_check";
        ALTER TABLE "ReconciliationIssue" ADD CONSTRAINT "ReconciliationIssue_kind_s14_check"
          CHECK ("kind" IN ('MISSING_IN_LEDGER','MISSING_AT_PROVIDER','AMOUNT_MISMATCH','CURRENCY_MISMATCH',
                            'DUPLICATE_AT_PROVIDER','INVALID_PROVIDER_RECORD','STATUS_MISMATCH'));
        ALTER TABLE "ReconciliationIssue" DROP CONSTRAINT IF EXISTS "ReconciliationIssue_status_check";
        ALTER TABLE "ReconciliationIssue" ADD CONSTRAINT "ReconciliationIssue_status_check"
          CHECK ("status" IN ('OPEN','RESOLVED'));
        ALTER TABLE "ReconciliationIssue" DROP CONSTRAINT IF EXISTS "ReconciliationIssue_resolution_check";
        ALTER TABLE "ReconciliationIssue" ADD CONSTRAINT "ReconciliationIssue_resolution_check"
          CHECK ("resolution" IS NULL OR "resolution" IN ('explained','adjusted','auto_matched'));
        ALTER TABLE "ReconciliationIssue" DROP CONSTRAINT IF EXISTS "ReconciliationIssue_note_check";
        ALTER TABLE "ReconciliationIssue" ADD CONSTRAINT "ReconciliationIssue_note_check"
          CHECK ("note" IS NULL OR char_length("note") <= 500);

        CREATE TABLE IF NOT EXISTS "ReconciliationIssueHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "issueId" UUID NOT NULL,
          "at" TIMESTAMPTZ NOT NULL,
          "actor" TEXT NOT NULL,
          "from" TEXT NOT NULL,
          "to" TEXT NOT NULL,
          "resolution" TEXT NULL,
          "note" TEXT NULL
        );
        CREATE INDEX IF NOT EXISTS "ReconciliationIssueHistory_issue_idx"
          ON "ReconciliationIssueHistory" ("issueId", "at");

        CREATE TABLE IF NOT EXISTS "ReconciliationStaging" (
          "runId" UUID NOT NULL,
          "kind" TEXT NOT NULL,
          "reference" TEXT NOT NULL,
          "details" JSONB NOT NULL DEFAULT '{}',
          PRIMARY KEY ("runId", "kind", "reference")
        );

        CREATE TABLE IF NOT EXISTS "ReconciliationSeen" (
          "runId" UUID NOT NULL,
          "reference" TEXT NOT NULL,
          PRIMARY KEY ("runId", "reference")
        );

        CREATE OR REPLACE FUNCTION reconciliation_history_insert_only() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION '% is insert-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
        END;
        $$ LANGUAGE plpgsql;
        DROP TRIGGER IF EXISTS reconciliation_history_insert_only ON "ReconciliationIssueHistory";
        CREATE TRIGGER reconciliation_history_insert_only BEFORE UPDATE OR DELETE ON "ReconciliationIssueHistory"
          FOR EACH ROW EXECUTE FUNCTION reconciliation_history_insert_only();
      `);
    });
  },

  async down() {
    throw new Error('Irreversible: reconciliation history would be lost.');
  },
};
