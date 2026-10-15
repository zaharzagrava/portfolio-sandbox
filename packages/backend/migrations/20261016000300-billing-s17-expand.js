'use strict';

/**
 * S17 subscriptions, expand step (III.11, IX.4; specs/domains/S17-subscriptions/data-model.md). Additive and
 * idempotent: every statement is `IF NOT EXISTS`, guarded by the catalog, or `CREATE OR REPLACE`, so running it twice
 * changes nothing (AS-84). Existing column names (`unitAmount`, `total`, `amount`, `overagePer1000`) stay: old
 * readers keep working while the code rolls out; the API renames them `...Minor`.
 *
 * Not one transaction for the whole file (T005): each statement group runs in its own short transaction with
 * `SET LOCAL lock_timeout`, and the data conversion runs in bounded batches (500 subscriptions' worth of invoices),
 * each its own transaction, so a long backfill never holds a lock across the file.
 *
 *  - `Plan`: code / audience / entitlement checks (NOT VALID, then validated), seat seeds 5 and 25;
 *  - `Price`: `version`, `trialDays`, bounds, EUR only, unique version, trigger `billing_price_immutable`;
 *  - `Subscription`: status clock, cancellation facts, `creditBalanceMinor`, partial indexes for the run;
 *  - `Invoice`: `businessKey` (unique per subscription), attempt fields, `paidAt`, keyset index, trigger
 *    `billing_invoice_immutable`; `InvoiceLine` immutable, kinds widened;
 *  - `SubscriptionTransition`, `InvoiceTransition` (append only), `SubjectPlanState` (per-shop tier counter);
 *  - negative open `PRORATION` invoices become credit balance (history reason `migrated_credit`).
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;
const BATCH = 500;

/** Runs `body` only when `column` does not exist yet (the DO block adds the column and backfills inside it). */
const whenColumnMissing = (table, column, body) => `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = '${table}' AND column_name = '${column}') THEN
      ${body}
    END IF;
  END $$;`;

/** Adds a constraint once (NOT VALID keeps the lock short; validation is a separate group). */
const addConstraint = (table, name, definition) => [
  `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`,
  `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${definition} NOT VALID`,
];

const ENTITLEMENT_KEYS = `'freeShipping','earlyAccessDrops','maxProducts','seats','auctions','apiCallsPerMonth','assistantTokensPerMonth'`;

const GROUPS = [
  // ---- Plan ------------------------------------------------------------------------------------------------------
  [
    `CREATE OR REPLACE FUNCTION billing_entitlements_valid(e jsonb) RETURNS boolean AS $fn$
       SELECT jsonb_typeof(e) = 'object' AND NOT EXISTS (
         SELECT 1 FROM jsonb_each(e) AS kv(k, v)
          WHERE k NOT IN (${ENTITLEMENT_KEYS})
             OR NOT (jsonb_typeof(v) = 'boolean' OR (jsonb_typeof(v) = 'number' AND (v #>> '{}')::numeric >= 0)))
     $fn$ LANGUAGE sql IMMUTABLE`,
    ...addConstraint('Plan', 'Plan_code_format', `CHECK ("code" ~ '^[a-z][a-z0-9-]{1,31}$')`),
    ...addConstraint(
      'Plan',
      'Plan_shop_codes',
      `CHECK ("audience" = 'BUYER' OR "code" IN ('starter','pro','enterprise'))`,
    ),
    ...addConstraint('Plan', 'Plan_entitlements_valid', `CHECK (billing_entitlements_valid("entitlements"))`),
    // Only where the seed still holds the old value: an operator-edited number is not overwritten.
    `UPDATE "Plan" SET "entitlements" = jsonb_set("entitlements", '{seats}', '5')
      WHERE "code" = 'starter' AND "entitlements"->>'seats' = '2'`,
    `UPDATE "Plan" SET "entitlements" = jsonb_set("entitlements", '{seats}', '25')
      WHERE "code" = 'pro' AND "entitlements"->>'seats' = '20'`,
  ],
  [
    `ALTER TABLE "Plan" VALIDATE CONSTRAINT "Plan_code_format"`,
    `ALTER TABLE "Plan" VALIDATE CONSTRAINT "Plan_shop_codes"`,
    `ALTER TABLE "Plan" VALIDATE CONSTRAINT "Plan_entitlements_valid"`,
  ],

  // ---- Price -----------------------------------------------------------------------------------------------------
  [
    whenColumnMissing(
      'Price',
      'version',
      `ALTER TABLE "Price" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
       UPDATE "Price" p SET "version" = n.rn
         FROM (SELECT "id", row_number() OVER (PARTITION BY "planId", "interval" ORDER BY "createdAt", "id") AS rn
                 FROM "Price") n
        WHERE p."id" = n."id";`,
    ),
    `ALTER TABLE "Price" ADD COLUMN IF NOT EXISTS "trialDays" INTEGER NOT NULL DEFAULT 0`,
    ...addConstraint('Price', 'Price_trial_days', `CHECK ("trialDays" BETWEEN 0 AND 90)`),
    ...addConstraint('Price', 'Price_amount_bounds', `CHECK ("unitAmount" BETWEEN 0 AND 100000000)`),
    ...addConstraint('Price', 'Price_currency_eur', `CHECK ("currency" = 'EUR')`),
    `CREATE UNIQUE INDEX IF NOT EXISTS "Price_plan_interval_version_uq" ON "Price" ("planId", "interval", "version")`,
  ],
  [
    `ALTER TABLE "Price" VALIDATE CONSTRAINT "Price_trial_days"`,
    `ALTER TABLE "Price" VALIDATE CONSTRAINT "Price_amount_bounds"`,
    `ALTER TABLE "Price" VALIDATE CONSTRAINT "Price_currency_eur"`,
  ],
  [
    `CREATE OR REPLACE FUNCTION billing_price_immutable() RETURNS trigger AS $fn$
     BEGIN
       IF TG_OP = 'DELETE' THEN
         IF EXISTS (SELECT 1 FROM "Subscription" WHERE "priceId" = OLD."id") THEN
           RAISE EXCEPTION 'billing_price_immutable: a price that subscriptions use is never deleted';
         END IF;
         RETURN OLD;
       END IF;
       IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN
         RAISE EXCEPTION 'billing_price_immutable: the commercial fields of a price never change (publish a new version)';
       END IF;
       IF OLD."active" = false AND NEW."active" = true THEN
         RAISE EXCEPTION 'billing_price_immutable: a retired price is never reactivated';
       END IF;
       RETURN NEW;
     END
     $fn$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS billing_price_immutable ON "Price"`,
    `CREATE TRIGGER billing_price_immutable BEFORE UPDATE OR DELETE ON "Price"
       FOR EACH ROW EXECUTE FUNCTION billing_price_immutable()`,
  ],

  // ---- Subscription ----------------------------------------------------------------------------------------------
  [
    whenColumnMissing(
      'Subscription',
      'statusSince',
      `ALTER TABLE "Subscription" ADD COLUMN "statusSince" TIMESTAMPTZ NOT NULL DEFAULT now();
       UPDATE "Subscription" SET "statusSince" = "updatedAt";`,
    ),
    `ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "canceledAt" TIMESTAMPTZ NULL`,
    `ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT NULL`,
    `ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "offboardingStartedAt" TIMESTAMPTZ NULL`,
    `ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "creditBalanceMinor" BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE "Subscription" DROP CONSTRAINT IF EXISTS "Subscription_credit_nonnegative"`,
    `ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_credit_nonnegative" CHECK ("creditBalanceMinor" >= 0)`,
    `CREATE INDEX IF NOT EXISTS "Subscription_run_due_idx" ON "Subscription" ("currentPeriodEnd", "id")
       WHERE "status" IN ('TRIALING','ACTIVE')`,
    `CREATE INDEX IF NOT EXISTS "Subscription_unpaid_idx" ON "Subscription" ("statusSince") WHERE "status" = 'UNPAID'`,
    `CREATE INDEX IF NOT EXISTS "Subscription_subject_idx" ON "Subscription" ("subjectType", "subjectId")`,
  ],

  // ---- Invoice ---------------------------------------------------------------------------------------------------
  [
    whenColumnMissing(
      'Invoice',
      'businessKey',
      `ALTER TABLE "Invoice" ADD COLUMN "businessKey" TEXT NULL;
       UPDATE "Invoice" SET "businessKey" = CASE
           WHEN "kind" = 'RENEWAL'
             THEN 'renewal:' || to_char("periodStart" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           ELSE 'proration:' || "id"::text END;
       ALTER TABLE "Invoice" ALTER COLUMN "businessKey" SET NOT NULL;`,
    ),
    `CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_business_key_uq" ON "Invoice" ("subscriptionId", "businessKey")`,
    // The old UNIQUE(subscriptionId, periodStart, kind) would refuse two changes at one instant (AS-67, frozen clocks):
    // the business key replaces it, and the only writer that relied on it (findOrCreate) is replaced in the same release.
    `ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_subscriptionId_periodStart_kind_key"`,
    `ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "attemptStartedAt" TIMESTAMPTZ NULL`,
    `ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "attemptUnknown" BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "manualAttempts" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "firstFailedAt" TIMESTAMPTZ NULL`,
    whenColumnMissing(
      'Invoice',
      'paidAt',
      `ALTER TABLE "Invoice" ADD COLUMN "paidAt" TIMESTAMPTZ NULL;
       UPDATE "Invoice" SET "paidAt" = "updatedAt" WHERE "status" = 'PAID';`,
    ),
    `CREATE INDEX IF NOT EXISTS "Invoice_subscription_created_idx" ON "Invoice" ("subscriptionId", "createdAt" DESC, "id" DESC)`,
    `CREATE INDEX IF NOT EXISTS "Invoice_attempt_due_idx" ON "Invoice" ("nextAttemptAt") WHERE "status" = 'OPEN'`,
  ],
  [
    `CREATE OR REPLACE FUNCTION billing_invoice_immutable() RETURNS trigger AS $fn$
     DECLARE
       mutable text[] := ARRAY['status','attempts','attemptStartedAt','attemptUnknown','manualAttempts',
                               'firstFailedAt','nextAttemptAt','paidAt','updatedAt'];
     BEGIN
       IF TG_OP = 'DELETE' THEN
         RAISE EXCEPTION 'billing_invoice_immutable: an invoice is a financial record and is never deleted';
       END IF;
       IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
         RAISE EXCEPTION 'billing_invoice_immutable: an issued invoice never changes except its status and attempt fields';
       END IF;
       IF NEW."status" <> OLD."status" AND NOT (
            (OLD."status" = 'OPEN' AND NEW."status" IN ('PAID','UNCOLLECTIBLE')) OR
            (OLD."status" = 'UNCOLLECTIBLE' AND NEW."status" = 'PAID')) THEN
         RAISE EXCEPTION 'billing_invoice_immutable: invoice status % -> % is not allowed', OLD."status", NEW."status";
       END IF;
       RETURN NEW;
     END
     $fn$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS billing_invoice_immutable ON "Invoice"`,
    `CREATE TRIGGER billing_invoice_immutable BEFORE UPDATE OR DELETE ON "Invoice"
       FOR EACH ROW EXECUTE FUNCTION billing_invoice_immutable()`,
    `CREATE OR REPLACE FUNCTION billing_invoice_line_immutable() RETURNS trigger AS $fn$
     BEGIN
       RAISE EXCEPTION 'billing_invoice_line_immutable: invoice lines are never updated or deleted';
     END
     $fn$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS billing_invoice_line_immutable ON "InvoiceLine"`,
    `CREATE TRIGGER billing_invoice_line_immutable BEFORE UPDATE OR DELETE ON "InvoiceLine"
       FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_immutable()`,
    ...addConstraint(
      'InvoiceLine',
      'InvoiceLine_kind_known',
      `CHECK ("kind" IN ('PLAN','USAGE','ADJUSTMENT','CREDIT','PRORATION_CREDIT','PRORATION_CHARGE','PRORATION'))`,
    ),
  ],

  // ---- Histories and the per-shop tier counter -------------------------------------------------------------------
  [
    `CREATE TABLE IF NOT EXISTS "SubscriptionTransition" (
       "id" UUID PRIMARY KEY DEFAULT uuidv7(),
       "subscriptionId" UUID NOT NULL REFERENCES "Subscription"("id"),
       "fromStatus" TEXT NULL,
       "toStatus" TEXT NOT NULL,
       "reason" TEXT NOT NULL,
       "actor" TEXT NOT NULL CHECK ("actor" ~ '^(user:[0-9a-f-]{36}|system:billing-run|system:dunning|event:[0-9a-f-]{36})$'),
       "at" TIMESTAMPTZ NOT NULL,
       "version" INTEGER NOT NULL,
       UNIQUE ("subscriptionId", "version")
     )`,
    `CREATE TABLE IF NOT EXISTS "InvoiceTransition" (
       "id" UUID PRIMARY KEY DEFAULT uuidv7(),
       "invoiceId" UUID NOT NULL REFERENCES "Invoice"("id"),
       "fromStatus" TEXT NOT NULL,
       "toStatus" TEXT NOT NULL,
       "reason" TEXT NOT NULL,
       "at" TIMESTAMPTZ NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS "InvoiceTransition_invoice_idx" ON "InvoiceTransition" ("invoiceId", "at")`,
    `CREATE TABLE IF NOT EXISTS "SubjectPlanState" (
       "subjectType" TEXT NOT NULL CHECK ("subjectType" IN ('USER','SHOP')),
       "subjectId" UUID NOT NULL,
       "tier" TEXT NOT NULL CHECK ("tier" IN ('STARTER','PRO','ENTERPRISE')),
       "planVersion" INTEGER NOT NULL,
       "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY ("subjectType", "subjectId")
     )`,
    `CREATE OR REPLACE FUNCTION billing_history_append_only() RETURNS trigger AS $fn$
     BEGIN
       RAISE EXCEPTION 'billing_history_append_only: history rows are never updated or deleted';
     END
     $fn$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS billing_history_append_only ON "SubscriptionTransition"`,
    `CREATE TRIGGER billing_history_append_only BEFORE UPDATE OR DELETE ON "SubscriptionTransition"
       FOR EACH ROW EXECUTE FUNCTION billing_history_append_only()`,
    `DROP TRIGGER IF EXISTS billing_history_append_only ON "InvoiceTransition"`,
    `CREATE TRIGGER billing_history_append_only BEFORE UPDATE OR DELETE ON "InvoiceTransition"
       FOR EACH ROW EXECUTE FUNCTION billing_history_append_only()`,
  ],
];

/**
 * Open negative `PRORATION` invoices (the old way of keeping a downgrade credit) become `creditBalanceMinor` on their
 * subscription and are closed, in batches. Only `WHERE status = 'OPEN' AND total < 0`, so a second run finds nothing.
 */
const CONVERT_BATCH = `
  WITH batch AS (
    SELECT "id", "subscriptionId", "total" FROM "Invoice"
     WHERE "kind" = 'PRORATION' AND "status" = 'OPEN' AND "total" < 0
     ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
  ), credited AS (
    UPDATE "Subscription" s SET "creditBalanceMinor" = s."creditBalanceMinor" + agg."amount"
      FROM (SELECT "subscriptionId", sum(-"total") AS "amount" FROM batch GROUP BY "subscriptionId") agg
     WHERE s."id" = agg."subscriptionId"
     RETURNING s."id"
  ), closed AS (
    UPDATE "Invoice" i SET "status" = 'PAID', "paidAt" = now(), "updatedAt" = now()
      FROM batch WHERE i."id" = batch."id"
     RETURNING i."id"
  ), history AS (
    INSERT INTO "InvoiceTransition" ("invoiceId", "fromStatus", "toStatus", "reason", "at")
    SELECT "id", 'OPEN', 'PAID', 'migrated_credit', now() FROM closed
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM closed)::int AS converted, (SELECT count(*) FROM credited)::int AS credited`;

async function inTransaction(queryInterface, statements) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(LOCK_TIMEOUT, { transaction });
    for (const sql of statements) {
      await queryInterface.sequelize.query(sql, { transaction });
    }
  });
}

module.exports = {
  GROUPS,
  CONVERT_BATCH,
  async up(queryInterface) {
    for (const group of GROUPS) await inTransaction(queryInterface, group);
    for (;;) {
      const [rows] = await queryInterface.sequelize.transaction(async (transaction) =>
        queryInterface.sequelize.query(CONVERT_BATCH, { transaction }),
      );
      if (!rows[0] || rows[0].converted === 0) break;
    }
  },
  async down(queryInterface) {
    // Additions only; the previous shape is untouched. The credit balance is not turned back into invoices.
    await inTransaction(queryInterface, [
      `ALTER TABLE "Plan" DROP CONSTRAINT IF EXISTS "Plan_entitlements_valid"`,
      `DROP TRIGGER IF EXISTS billing_history_append_only ON "InvoiceTransition"`,
      `DROP TRIGGER IF EXISTS billing_history_append_only ON "SubscriptionTransition"`,
      `DROP TRIGGER IF EXISTS billing_invoice_line_immutable ON "InvoiceLine"`,
      `DROP TRIGGER IF EXISTS billing_invoice_immutable ON "Invoice"`,
      `DROP TRIGGER IF EXISTS billing_price_immutable ON "Price"`,
      `DROP TABLE IF EXISTS "SubjectPlanState", "InvoiceTransition", "SubscriptionTransition"`,
      `DROP FUNCTION IF EXISTS billing_history_append_only(), billing_invoice_line_immutable(),
         billing_invoice_immutable(), billing_price_immutable(), billing_entitlements_valid(jsonb)`,
    ]);
  },
};
