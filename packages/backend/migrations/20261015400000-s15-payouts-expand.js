'use strict';

/**
 * S15 payouts, expand step (III.11, IX.4). Nothing is dropped or renamed, so the deployed payout code keeps working:
 *  - `Payout`: the new columns (nullable or constant defaults), the status CHECK widened to the six statuses
 *    (NOT VALID, then VALIDATED), the foreign key to `Shop` dropped (found by catalog, `shopId` stays a plain id), a
 *    dual-write trigger that keeps `amount`/`amountMinor` and `providerRef`/`transferRef` equal for old readers;
 *  - nine tables owned by `payments`: PayoutHistory, PayoutRun, PayoutDestination, PayoutDestinationHistory,
 *    PayoutReserve, PayoutReserveHistory, PayoutAuditDay, PayoutAuditFinding (the ninth is `Payout` itself, expanded
 *    above), append-only triggers on the three history tables;
 *  - indexes (`IF NOT EXISTS`; one row per shop per week keeps `Payout` small, a large deployment runs the index
 *    statements by hand with CONCURRENTLY before this file);
 *  - the backfill, each statement idempotent and batched: `amountMinor`, `transferRef`, destinations (from the
 *    S14 `ProviderAccount` and, only while the column exists, from `Shop.stripeAccountId`), `destinationSnapshot`,
 *    and one `∅ -> status` history row per payout that has none.
 *
 * The contract step (drop `amount`, `providerRef`, `ProviderAccount`) is a later file and refuses to run unless the
 * counts and checksums agree. `down` reverses the additions only and never restores the `Shop` foreign key.
 */
const STATUSES = `'PENDING','SENDING','UNKNOWN','PAID','FAILED','CANCELLED'`;
const BATCH = 5000;

/** One backfill statement per concern, exported so a spec can run them against rows it seeds. */
const BACKFILL_SQL = {
  amounts: `
    DO $$
    DECLARE moved integer;
    BEGIN
      LOOP
        WITH batch AS (SELECT "id" FROM "Payout" WHERE "amountMinor" IS NULL LIMIT ${BATCH})
        UPDATE "Payout" p SET "amountMinor" = p."amount" FROM batch WHERE p."id" = batch."id";
        GET DIAGNOSTICS moved = ROW_COUNT;
        EXIT WHEN moved = 0;
      END LOOP;
    END $$;
    UPDATE "Payout" SET "transferRef" = "providerRef" WHERE "transferRef" IS NULL AND "providerRef" IS NOT NULL;
  `,
  destinations: `
    INSERT INTO "PayoutDestination" ("shopId", "providerAccountId", "effectiveFrom", "changedAt", "changedBy")
    SELECT "shopId", "accountId", now(), now(), 'migration' FROM "ProviderAccount"
    ON CONFLICT ("shopId") DO NOTHING;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'Shop' AND column_name = 'stripeAccountId') THEN
        EXECUTE 'INSERT INTO "PayoutDestination" ("shopId", "providerAccountId", "effectiveFrom", "changedAt", "changedBy")
                 SELECT "id", "stripeAccountId", now(), now(), ''migration'' FROM "Shop" WHERE "stripeAccountId" IS NOT NULL
                 ON CONFLICT ("shopId") DO NOTHING';
      END IF;
    END $$;
    UPDATE "Payout" p SET "destinationSnapshot" = d."providerAccountId"
      FROM "PayoutDestination" d WHERE p."shopId" = d."shopId" AND p."destinationSnapshot" IS NULL;
  `,
  history: `
    INSERT INTO "PayoutHistory" ("payoutId", "fromStatus", "toStatus", "payoutVersion", "actor", "reason", "at")
    SELECT p."id", NULL, p."status", 1, 'migration', NULL, p."createdAt" FROM "Payout" p
     WHERE NOT EXISTS (SELECT 1 FROM "PayoutHistory" h WHERE h."payoutId" = p."id");
  `,
};

module.exports = {
  BACKFILL_SQL,

  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);

      // ---- Payout: new columns (metadata-only: nullable or constant defaults)
      await q(`
        ALTER TABLE "Payout"
          ADD COLUMN IF NOT EXISTS "amountMinor" BIGINT NULL,
          ADD COLUMN IF NOT EXISTS "reserveHeldMinor" BIGINT NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "destinationSnapshot" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "transferRef" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "failureCode" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "resendCount" SMALLINT NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "lookupFailures" SMALLINT NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "nextResolveAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "inDoubtSince" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "inDoubtEventAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "discrepancyReportedAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "payoutVersion" INTEGER NOT NULL DEFAULT 1
      `);

      await q(`
        DO $$
        DECLARE c record;
        BEGIN
          -- the old status CHECK (any name) is replaced by one admitting the six statuses
          FOR c IN SELECT conname FROM pg_constraint
                    WHERE conrelid = '"Payout"'::regclass AND contype = 'c'
                      AND conname <> 'Payout_status_s15_check'
                      AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
            EXECUTE format('ALTER TABLE "Payout" DROP CONSTRAINT %I', c.conname);
          END LOOP;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Payout"'::regclass AND conname = 'Payout_status_s15_check') THEN
            ALTER TABLE "Payout" ADD CONSTRAINT "Payout_status_s15_check" CHECK ("status" IN (${STATUSES})) NOT VALID;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Payout"'::regclass AND conname = 'Payout_amountMinor_positive') THEN
            ALTER TABLE "Payout" ADD CONSTRAINT "Payout_amountMinor_positive" CHECK ("amountMinor" IS NULL OR "amountMinor" > 0) NOT VALID;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Payout"'::regclass AND conname = 'Payout_reserveHeld_nonneg') THEN
            ALTER TABLE "Payout" ADD CONSTRAINT "Payout_reserveHeld_nonneg" CHECK ("reserveHeldMinor" >= 0) NOT VALID;
          END IF;
          -- the foreign key to Shop (found by catalog, not by name): shopId is a plain id from now on
          FOR c IN SELECT conname FROM pg_constraint
                    WHERE conrelid = '"Payout"'::regclass AND contype = 'f'
                      AND confrelid = to_regclass('"Shop"') LOOP
            EXECUTE format('ALTER TABLE "Payout" DROP CONSTRAINT %I', c.conname);
          END LOOP;
        END $$;
        ALTER TABLE "Payout" VALIDATE CONSTRAINT "Payout_status_s15_check";
        ALTER TABLE "Payout" VALIDATE CONSTRAINT "Payout_amountMinor_positive";
        ALTER TABLE "Payout" VALIDATE CONSTRAINT "Payout_reserveHeld_nonneg";
      `);

      // ---- dual write for old readers: either name of the same fact is enough
      await q(`
        CREATE OR REPLACE FUNCTION payout_dual_write() RETURNS trigger AS $$
        BEGIN
          IF NEW."amountMinor" IS NULL THEN NEW."amountMinor" := NEW."amount"; END IF;
          IF NEW."amount" IS NULL THEN NEW."amount" := NEW."amountMinor"; END IF;
          IF NEW."transferRef" IS NULL AND NEW."providerRef" IS NOT NULL THEN NEW."transferRef" := NEW."providerRef"; END IF;
          IF NEW."providerRef" IS NULL AND NEW."transferRef" IS NOT NULL THEN NEW."providerRef" := NEW."transferRef"; END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        DROP TRIGGER IF EXISTS payout_dual_write ON "Payout";
        CREATE TRIGGER payout_dual_write BEFORE INSERT OR UPDATE ON "Payout"
          FOR EACH ROW EXECUTE FUNCTION payout_dual_write();
      `);

      // ---- new tables (no foreign key to any other owner; shopId is a plain id)
      await q(`
        CREATE TABLE IF NOT EXISTS "PayoutHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "payoutId" UUID NOT NULL,
          "fromStatus" TEXT NULL CHECK ("fromStatus" IS NULL OR "fromStatus" IN (${STATUSES})),
          "toStatus" TEXT NOT NULL CHECK ("toStatus" IN (${STATUSES})),
          "payoutVersion" INTEGER NOT NULL,
          "actor" TEXT NOT NULL,
          "reason" TEXT NULL CHECK ("reason" IS NULL OR char_length("reason") <= 200),
          "at" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS "PayoutRun" (
          "periodStart" DATE PRIMARY KEY,
          "status" TEXT NOT NULL CHECK ("status" IN ('RUNNING','COMPLETED','FAILED')),
          "created" INTEGER NOT NULL DEFAULT 0,
          "existing" INTEGER NOT NULL DEFAULT 0,
          "skipped" JSONB NOT NULL DEFAULT '{}',
          "failureCode" TEXT NULL,
          "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "finishedAt" TIMESTAMPTZ NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS "PayoutDestination" (
          "shopId" UUID PRIMARY KEY,
          "providerAccountId" TEXT NOT NULL,
          "effectiveFrom" TIMESTAMPTZ NOT NULL,
          "changedAt" TIMESTAMPTZ NOT NULL,
          "changedBy" TEXT NOT NULL,
          "version" INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS "PayoutDestinationHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopId" UUID NOT NULL,
          "fromMasked" TEXT NULL,
          "toMasked" TEXT NOT NULL,
          "effectiveFrom" TIMESTAMPTZ NOT NULL,
          "at" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "actor" TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "PayoutReserve" (
          "shopId" UUID PRIMARY KEY,
          "reserveBps" SMALLINT NOT NULL CHECK ("reserveBps" BETWEEN 0 AND 5000),
          "reason" TEXT NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 200),
          "updatedBy" TEXT NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS "PayoutReserveHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopId" UUID NOT NULL,
          "previousBps" SMALLINT NULL,
          "reserveBps" SMALLINT NOT NULL,
          "reason" TEXT NOT NULL,
          "actor" TEXT NOT NULL,
          "at" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS "PayoutAuditDay" (
          "day" DATE PRIMARY KEY,
          "status" TEXT NOT NULL CHECK ("status" IN ('RUNNING','COMPLETED','FAILED')),
          "checked" INTEGER NOT NULL DEFAULT 0,
          "discrepancies" INTEGER NOT NULL DEFAULT 0,
          "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "finishedAt" TIMESTAMPTZ NULL
        );

        CREATE TABLE IF NOT EXISTS "PayoutAuditFinding" (
          "payoutId" UUID NOT NULL,
          "kind" TEXT NOT NULL,
          "day" DATE NOT NULL,
          "foundAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("payoutId", "kind")
        );
      `);

      // ---- the histories are append-only (ledger_append_only() is S14's generic trigger function)
      for (const table of ['PayoutHistory', 'PayoutDestinationHistory', 'PayoutReserveHistory']) {
        await q(`
          DROP TRIGGER IF EXISTS ledger_append_only ON "${table}";
          CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON "${table}"
            FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
        `);
      }

      // ---- indexes
      await q(`
        CREATE INDEX IF NOT EXISTS "Payout_shop_period_idx" ON "Payout" ("shopId", "periodStart" DESC, "id" DESC);
        CREATE INDEX IF NOT EXISTS "Payout_created_idx" ON "Payout" ("createdAt" DESC, "id" DESC);
        CREATE INDEX IF NOT EXISTS "Payout_status_created_idx" ON "Payout" ("status", "createdAt" DESC, "id" DESC);
        CREATE INDEX IF NOT EXISTS "Payout_resolve_idx" ON "Payout" ("nextResolveAt") WHERE "status" IN ('SENDING','UNKNOWN');
        CREATE INDEX IF NOT EXISTS "Payout_paid_idx" ON "Payout" ("paidAt") WHERE "status" = 'PAID';
        CREATE INDEX IF NOT EXISTS "PayoutHistory_payout_idx" ON "PayoutHistory" ("payoutId", "id");
        CREATE INDEX IF NOT EXISTS "PayoutDestinationHistory_shop_idx" ON "PayoutDestinationHistory" ("shopId", "id");
        CREATE INDEX IF NOT EXISTS "PayoutReserveHistory_shop_idx" ON "PayoutReserveHistory" ("shopId", "id");
      `);

      // ---- backfill (idempotent; the destination copy reads Shop only while its column exists)
      await q(BACKFILL_SQL.amounts);
      await q(BACKFILL_SQL.destinations);
      await q(BACKFILL_SQL.history);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        DROP TRIGGER IF EXISTS payout_dual_write ON "Payout";
        DROP FUNCTION IF EXISTS payout_dual_write();
        DROP TABLE IF EXISTS "PayoutAuditFinding", "PayoutAuditDay", "PayoutReserveHistory", "PayoutReserve",
          "PayoutDestinationHistory", "PayoutDestination", "PayoutRun", "PayoutHistory";
        DROP INDEX IF EXISTS "Payout_shop_period_idx", "Payout_created_idx", "Payout_status_created_idx",
          "Payout_resolve_idx", "Payout_paid_idx";
        ALTER TABLE "Payout"
          DROP CONSTRAINT IF EXISTS "Payout_amountMinor_positive",
          DROP CONSTRAINT IF EXISTS "Payout_reserveHeld_nonneg",
          DROP COLUMN IF EXISTS "amountMinor", DROP COLUMN IF EXISTS "reserveHeldMinor",
          DROP COLUMN IF EXISTS "destinationSnapshot", DROP COLUMN IF EXISTS "transferRef",
          DROP COLUMN IF EXISTS "failureCode", DROP COLUMN IF EXISTS "attempts",
          DROP COLUMN IF EXISTS "resendCount", DROP COLUMN IF EXISTS "lookupFailures",
          DROP COLUMN IF EXISTS "nextResolveAt", DROP COLUMN IF EXISTS "inDoubtSince",
          DROP COLUMN IF EXISTS "inDoubtEventAt", DROP COLUMN IF EXISTS "discrepancyReportedAt",
          DROP COLUMN IF EXISTS "submittedAt", DROP COLUMN IF EXISTS "paidAt",
          DROP COLUMN IF EXISTS "cancelledAt", DROP COLUMN IF EXISTS "payoutVersion";
      `);
    });
  },
};
