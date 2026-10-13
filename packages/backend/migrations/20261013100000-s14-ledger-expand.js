'use strict';

/**
 * S14 payments, expand step 1 (III.11, IX.4): the journal header, the running balances, the checkpoint and backfill
 * cursor tables, the payments-owned provider account table (one-time copy of Shop.stripeAccountId, no foreign key),
 * the `shard` and `currency` columns of the entries, append-only protection of every entries partition and of the
 * journal header, a partition function that copes with rows in the catch-all partition, and the drop of the foreign
 * key LedgerEntry.paymentId -> Payment (a plain id from now on).
 *
 * TRUNCATE is deliberately not trapped: the test cleanup (IX.6) truncates every table, and in production the
 * application role has no TRUNCATE privilege (the ops note in the S14 quickstart).
 */
const KINDS = `'SALE','REFUND','SETTLEMENT','SWEEP','PAYOUT','PAYOUT_REVERSAL','AD_CHARGE','ADJUSTMENT'`;

/** The data copy of the payout destination; exported so a spec can run it against rows it seeds. */
const PROVIDER_ACCOUNT_COPY_SQL = `
  INSERT INTO "ProviderAccount" ("shopId", "provider", "accountId")
  SELECT "id", 'stripe', "stripeAccountId" FROM "Shop" WHERE "stripeAccountId" IS NOT NULL
  ON CONFLICT ("shopId") DO NOTHING
`;

module.exports = {
  PROVIDER_ACCOUNT_COPY_SQL,

  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);

      await q(`
        CREATE TABLE IF NOT EXISTS "LedgerJournal" (
          "id" UUID PRIMARY KEY,
          "kind" TEXT NOT NULL CHECK ("kind" IN (${KINDS})),
          "reference" TEXT NOT NULL CHECK (char_length("reference") BETWEEN 1 AND 200),
          "currency" CHAR(3) NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
          "postedAt" TIMESTAMPTZ NOT NULL,
          "fingerprint" CHAR(64) NOT NULL,
          "paymentId" UUID NULL,
          "orderId" UUID NULL,
          "paymentRef" TEXT NULL,
          "refundRef" TEXT NULL,
          "userId" TEXT NULL,
          "clearingMinor" BIGINT NULL,
          "reversesJournalId" UUID NULL,
          "correctsDay" DATE NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS "AccountBalance" (
          "accountId" VARCHAR(255) NOT NULL,
          "shard" SMALLINT NOT NULL DEFAULT 0,
          "currency" CHAR(3) NOT NULL,
          "balanceMinor" BIGINT NOT NULL DEFAULT 0 CHECK (abs("balanceMinor") <= 9007199254740991),
          "version" BIGINT NOT NULL DEFAULT 0,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("accountId", "shard", "currency")
        );

        CREATE TABLE IF NOT EXISTS "LedgerCheckpoint" (
          "accountId" VARCHAR(255) NOT NULL,
          "shard" SMALLINT NOT NULL DEFAULT 0,
          "currency" CHAR(3) NOT NULL,
          "verifiedThrough" TIMESTAMPTZ NOT NULL,
          "balanceMinor" BIGINT NOT NULL,
          PRIMARY KEY ("accountId", "shard", "currency")
        );

        CREATE TABLE IF NOT EXISTS "LedgerBackfillCursor" (
          "name" TEXT PRIMARY KEY,
          "lastCreatedAt" TIMESTAMPTZ NULL,
          "lastId" UUID NULL,
          "rowsDone" BIGINT NOT NULL DEFAULT 0,
          "finishedAt" TIMESTAMPTZ NULL
        );

        CREATE TABLE IF NOT EXISTS "ProviderAccount" (
          "shopId" UUID PRIMARY KEY,
          "provider" TEXT NOT NULL DEFAULT 'stripe',
          "accountId" TEXT NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

      `);
      // One-time copy of the payout destination (S03 follow-up). A migration is the sanctioned place for this read.
      await q(PROVIDER_ACCOUNT_COPY_SQL);

      // Entries: two columns with constant defaults (metadata only, no rewrite) and a not-yet-validated check.
      await q(`
        ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "shard" SMALLINT NOT NULL DEFAULT 0;
        ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "currency" CHAR(3) NOT NULL DEFAULT 'EUR';
      `);
      const [checks] = await queryInterface.sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'LedgerEntry_currency_format' AND conrelid = '"LedgerEntry"'::regclass`,
        { transaction },
      );
      if (checks.length === 0)
        await q(
          `ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$') NOT VALID`,
        );

      // paymentId is a plain id from now on (D-17): drop the foreign key to Payment.
      const [fks] = await queryInterface.sequelize.query(
        `SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid = '"LedgerEntry"'::regclass`,
        { transaction },
      );
      for (const { conname } of fks)
        await q(`ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "${conname}"`);

      await q(`
        CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ledger_protect_partition(part TEXT) RETURNS VOID AS $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(format('%I', part)) AND tgname = 'ledger_balanced'
          ) THEN
            EXECUTE format('CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced()', part);
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(format('%I', part)) AND tgname = 'ledger_append_only'
          ) THEN
            EXECUTE format('CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ledger_append_only()', part);
          END IF;
        END;
        $$ LANGUAGE plpgsql;

        -- Rows of a month that has no partition yet sit in the catch-all partition. Postgres cannot create the
        -- month's partition while the catch-all holds rows for it, and the append-only trigger forbids moving them
        -- with DELETE: so the catch-all is rebuilt (detach, create the month and a fresh catch-all, re-insert,
        -- drop). Counts and sums are asserted before the transaction can commit (research R-3).
        CREATE OR REPLACE FUNCTION ledger_relocate_default(month DATE) RETURNS BIGINT AS $$
        DECLARE
          part TEXT := 'LedgerEntry_' || to_char(month, 'YYYYMM');
          lo TIMESTAMPTZ := month::timestamptz;
          hi TIMESTAMPTZ := (month + interval '1 month')::date::timestamptz;
          cnt_before BIGINT; sum_before NUMERIC; cnt_after BIGINT; sum_after NUMERIC; total_before BIGINT; total_after BIGINT;
        BEGIN
          SET LOCAL lock_timeout = '3s';
          LOCK TABLE "LedgerEntry" IN ACCESS EXCLUSIVE MODE;
          SELECT count(*), coalesce(sum(amount), 0) INTO cnt_before, sum_before
            FROM "LedgerEntry_default" WHERE "createdAt" >= lo AND "createdAt" < hi;
          SELECT count(*) INTO total_before FROM "LedgerEntry_default";
          ALTER TABLE "LedgerEntry" DETACH PARTITION "LedgerEntry_default";
          ALTER TABLE "LedgerEntry_default" RENAME TO "LedgerEntry_new_default";
          EXECUTE format('CREATE TABLE %I PARTITION OF "LedgerEntry" FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
          PERFORM ledger_protect_partition(part);
          CREATE TABLE "LedgerEntry_default" PARTITION OF "LedgerEntry" DEFAULT;
          PERFORM ledger_protect_partition('LedgerEntry_default');
          INSERT INTO "LedgerEntry" SELECT * FROM "LedgerEntry_new_default";
          EXECUTE format('SELECT count(*), coalesce(sum(amount), 0) FROM %I', part) INTO cnt_after, sum_after;
          SELECT count(*) INTO total_after FROM "LedgerEntry_default";
          IF cnt_after <> cnt_before OR sum_after <> sum_before OR total_after <> total_before - cnt_before THEN
            RAISE EXCEPTION 'ledger_relocate_default: counts or sums changed (% -> %, % -> %)', cnt_before, cnt_after, sum_before, sum_after;
          END IF;
          DROP TABLE "LedgerEntry_new_default";
          RETURN cnt_before;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ledger_ensure_partitions(from_month DATE, months INT) RETURNS VOID AS $$
        DECLARE m DATE; name TEXT; lo TIMESTAMPTZ; hi TIMESTAMPTZ; in_default BIGINT;
        BEGIN
          FOR i IN 0..months - 1 LOOP
            m := (date_trunc('month', from_month) + make_interval(months => i))::date;
            name := 'LedgerEntry_' || to_char(m, 'YYYYMM');
            lo := m::timestamptz;
            hi := (m + interval '1 month')::date::timestamptz;
            IF to_regclass(format('%I', name)) IS NULL THEN
              SELECT count(*) INTO in_default FROM "LedgerEntry_default" WHERE "createdAt" >= lo AND "createdAt" < hi;
              IF in_default > 0 THEN
                PERFORM ledger_relocate_default(m);
              ELSE
                EXECUTE format('CREATE TABLE %I PARTITION OF "LedgerEntry" FOR VALUES FROM (%L) TO (%L)', name, lo, hi);
                PERFORM ledger_protect_partition(name);
              END IF;
            ELSE
              PERFORM ledger_protect_partition(name);
            END IF;
          END LOOP;
        END;
        $$ LANGUAGE plpgsql;

        -- Protect every partition that exists now (monthly ones and the catch-all) and the journal header.
        DO $$
        DECLARE part RECORD;
        BEGIN
          FOR part IN
            SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
            WHERE i.inhparent = '"LedgerEntry"'::regclass
          LOOP
            PERFORM ledger_protect_partition(part.relname);
          END LOOP;
        END $$;

        DROP TRIGGER IF EXISTS ledger_append_only ON "LedgerJournal";
        CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON "LedgerJournal"
          FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
      `);
    });
  },

  async down() {
    throw new Error(
      'Irreversible: the journal and balance tables hold data the old code cannot read.',
    );
  },
};
