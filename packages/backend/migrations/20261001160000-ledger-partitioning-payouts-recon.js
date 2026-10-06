'use strict';

/**
 * SD-20 / README #11.
 *
 * 1. Payment.status gains UNKNOWN (provider timeout: we don't know if the card was charged).
 *    ALTER TYPE ... ADD VALUE can't be used in the same transaction that adds it → separate statement.
 * 2. LedgerEntry → monthly RANGE partitions on "createdAt" via copy-and-swap. Here the copy
 *    is one INSERT...SELECT; for a multi-billion-row table the same shape is done online:
 *    dual-write trigger + batched backfill + swap (documented in the section file).
 *    New columns: journalId (groups the lines of one balanced posting - payments, settlements,
 *    payouts), kind; paymentId becomes nullable (payouts have no payment).
 * 3. Balanced-journal invariant enforced by the database: a DEFERRABLE constraint trigger
 *    checks SUM(amount) = 0 per journal at COMMIT - application bugs can't write unbalanced books.
 * 4. Payouts + reconciliation tables, Shop.stripeAccountId (Connect destination).
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql, transaction) => queryInterface.sequelize.query(sql, { transaction });

    await q(`ALTER TYPE "enum_Payment_status" ADD VALUE IF NOT EXISTS 'UNKNOWN'`);

    await queryInterface.sequelize.transaction(async (transaction) => {
      await q(`SET LOCAL lock_timeout = '10s'`, transaction);
      await q(`ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "providerRef" TEXT NULL`, transaction);
      await q(`ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "stripeAccountId" TEXT NULL`, transaction);

      await q(`
        CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
        DECLARE total NUMERIC;
        BEGIN
          SELECT coalesce(sum(amount), 0) INTO total FROM "LedgerEntry" WHERE "journalId" = NEW."journalId";
          IF total <> 0 THEN
            RAISE EXCEPTION 'unbalanced ledger journal % (sum = %)', NEW."journalId", total USING ERRCODE = 'check_violation';
          END IF;
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TABLE "LedgerEntry_new" (
          "id" UUID NOT NULL DEFAULT uuidv7(),
          "journalId" UUID NOT NULL,
          "kind" TEXT NOT NULL DEFAULT 'SALE',
          "paymentId" UUID NULL REFERENCES "Payment"("id"),
          "accountId" VARCHAR(255) NOT NULL,
          "amount" BIGINT NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("id", "createdAt")
        ) PARTITION BY RANGE ("createdAt");

        -- Creates monthly partitions (+ the balanced-journal constraint trigger on each).
        CREATE OR REPLACE FUNCTION ledger_ensure_partitions(from_month DATE, months INT) RETURNS VOID AS $$
        DECLARE m DATE; name TEXT;
        BEGIN
          FOR i IN 0..months - 1 LOOP
            m := (date_trunc('month', from_month) + make_interval(months => i))::date;
            name := 'LedgerEntry_' || to_char(m, 'YYYYMM');
            IF to_regclass(format('%I', name)) IS NULL THEN
              EXECUTE format('CREATE TABLE %I PARTITION OF "LedgerEntry_new" FOR VALUES FROM (%L) TO (%L)', name, m, (m + interval '1 month')::date);
              EXECUTE format('CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced()', name);
            END IF;
          END LOOP;
        END;
        $$ LANGUAGE plpgsql;
      `, transaction);

      await q(`
        SELECT ledger_ensure_partitions(
          coalesce((SELECT min("createdAt") FROM "LedgerEntry"), now())::date,
          (extract(year FROM age(date_trunc('month', now()), date_trunc('month', coalesce((SELECT min("createdAt") FROM "LedgerEntry"), now())))) * 12
           + extract(month FROM age(date_trunc('month', now()), date_trunc('month', coalesce((SELECT min("createdAt") FROM "LedgerEntry"), now())))))::int + 4
        );
        CREATE TABLE "LedgerEntry_new_default" PARTITION OF "LedgerEntry_new" DEFAULT;
        CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON "LedgerEntry_new_default" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

        -- Existing rows: one sale journal per payment.
        INSERT INTO "LedgerEntry_new" ("id", "journalId", "kind", "paymentId", "accountId", "amount", "createdAt")
        SELECT "id", "paymentId", 'SALE', "paymentId", "accountId", "amount", "createdAt" FROM "LedgerEntry";

        ALTER TABLE "LedgerEntry" RENAME TO "LedgerEntry_legacy";
        ALTER TABLE "LedgerEntry_new" RENAME TO "LedgerEntry";
        ALTER TABLE "LedgerEntry_new_default" RENAME TO "LedgerEntry_default";

        -- Statements / balances: per account over time. Journal / payment lookups.
        CREATE INDEX "LedgerEntry_account_time_idx" ON "LedgerEntry" ("accountId", "createdAt");
        CREATE INDEX "LedgerEntry_journal_idx" ON "LedgerEntry" ("journalId");
        CREATE INDEX "LedgerEntry_payment_idx" ON "LedgerEntry" ("paymentId");
      `, transaction);

      // The function now targets the renamed parent.
      await q(`
        CREATE OR REPLACE FUNCTION ledger_ensure_partitions(from_month DATE, months INT) RETURNS VOID AS $$
        DECLARE m DATE; name TEXT;
        BEGIN
          FOR i IN 0..months - 1 LOOP
            m := (date_trunc('month', from_month) + make_interval(months => i))::date;
            name := 'LedgerEntry_' || to_char(m, 'YYYYMM');
            IF to_regclass(format('%I', name)) IS NULL THEN
              EXECUTE format('CREATE TABLE %I PARTITION OF "LedgerEntry" FOR VALUES FROM (%L) TO (%L)', name, m, (m + interval '1 month')::date);
              EXECUTE format('CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced()', name);
            END IF;
          END LOOP;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TABLE IF NOT EXISTS "Payout" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
          "amount" BIGINT NOT NULL CHECK ("amount" > 0),
          "currency" TEXT NOT NULL DEFAULT 'EUR',
          "periodStart" DATE NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','PAID','FAILED')),
          "providerRef" TEXT NULL,
          "failureReason" TEXT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE ("shopId", "periodStart")
        );

        CREATE TABLE IF NOT EXISTS "ReconciliationRun" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "provider" TEXT NOT NULL,
          "day" DATE NOT NULL,
          "matched" INTEGER NOT NULL DEFAULT 0,
          "issues" INTEGER NOT NULL DEFAULT 0,
          "finishedAt" TIMESTAMPTZ NULL,
          UNIQUE ("provider", "day")
        );

        CREATE TABLE IF NOT EXISTS "ReconciliationIssue" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "runId" UUID NOT NULL REFERENCES "ReconciliationRun"("id") ON DELETE CASCADE,
          "kind" TEXT NOT NULL CHECK ("kind" IN ('MISSING_IN_LEDGER','MISSING_AT_PROVIDER','AMOUNT_MISMATCH','STATUS_MISMATCH')),
          "reference" TEXT NOT NULL,
          "details" JSONB NOT NULL DEFAULT '{}',
          "resolvedAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "ReconciliationIssue_open_idx" ON "ReconciliationIssue" ("createdAt") WHERE "resolvedAt" IS NULL;
      `, transaction);
    });
  },

  async down() {
    throw new Error('Irreversible: LedgerEntry was converted to a partitioned table (LedgerEntry_legacy kept for manual rollback).');
  },
};
