'use strict';

/**
 * SD-29 job scheduler.
 *
 * "Job" is range-partitioned by "createdAt" (daily). Not by "runAt": a retry
 * reschedules runAt, and an UPDATE that moves a row across partitions makes
 * concurrent `FOR UPDATE SKIP LOCKED` claimers fail ("tuple to be locked was
 * already moved to another partition"). Old partitions are dropped wholesale
 * (instant) instead of DELETE-ing millions of finished rows (bloat, vacuum).
 *
 * Postgres can't enforce UNIQUE across partitions unless the key contains the
 * partition column, so idempotency keys live in "JobKey" (global PK) and are
 * inserted in the same transaction as the job.
 *
 * fillfactor=70 leaves room on each page so that after a VACUUM later updates
 * reuse the dead space and bloat stays bounded. Status updates are NOT heap-only
 * (status is in partial-index predicates); only columns no index mentions
 * (attempts, lastError, lockedBy) can be.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '5s'`);

      await q(`
        CREATE TABLE IF NOT EXISTS "Job" (
          "id" UUID NOT NULL DEFAULT uuidv7(),
          "type" TEXT NOT NULL,
          "payload" JSONB NOT NULL DEFAULT '{}',
          "status" TEXT NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED','RUNNING','SUCCEEDED','DEAD','CANCELLED')),
          "runAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "attempts" INTEGER NOT NULL DEFAULT 0,
          "maxAttempts" INTEGER NOT NULL DEFAULT 8,
          "lockedBy" TEXT NULL,
          "lockedUntil" TIMESTAMPTZ NULL,
          "lastError" TEXT NULL,
          "shopId" UUID NULL,
          "idempotencyKey" TEXT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "finishedAt" TIMESTAMPTZ NULL,
          PRIMARY KEY ("id", "createdAt")
        ) PARTITION BY RANGE ("createdAt");

        -- Catch-all so an insert never fails if maintenance fell behind.
        CREATE TABLE IF NOT EXISTS "Job_default" PARTITION OF "Job" DEFAULT WITH (fillfactor = 70);

        -- Claim path: only QUEUED rows, ordered by runAt. Partial → tiny index regardless of history size.
        CREATE INDEX IF NOT EXISTS "Job_due_idx" ON "Job" ("runAt") WHERE "status" = 'QUEUED';
        -- Reaper path: expired leases.
        CREATE INDEX IF NOT EXISTS "Job_running_lease_idx" ON "Job" ("lockedUntil") WHERE "status" = 'RUNNING';
        -- Fairness: running jobs per shop.
        CREATE INDEX IF NOT EXISTS "Job_running_shop_idx" ON "Job" ("shopId") WHERE "status" = 'RUNNING' AND "shopId" IS NOT NULL;

        CREATE TABLE IF NOT EXISTS "JobKey" (
          "idempotencyKey" TEXT PRIMARY KEY,
          "jobId" UUID NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS "JobSchedule" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "name" TEXT NOT NULL UNIQUE,
          "cron" TEXT NOT NULL,
          "timezone" TEXT NOT NULL DEFAULT 'UTC',
          "jobType" TEXT NOT NULL,
          "payload" JSONB NOT NULL DEFAULT '{}',
          "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
          "nextFireAt" TIMESTAMPTZ NOT NULL,
          "lastFiredAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "JobSchedule_due_idx" ON "JobSchedule" ("nextFireAt") WHERE "enabled";

        -- Creates daily partitions [from, from + days). Called by the migration and by the
        -- jobs.partition-maintenance job, so partitions always exist ahead of time.
        CREATE OR REPLACE FUNCTION job_ensure_partitions(from_day DATE, days INT) RETURNS VOID AS $$
        DECLARE d DATE; name TEXT;
        BEGIN
          FOR i IN 0..days - 1 LOOP
            d := from_day + i;
            name := 'Job_' || to_char(d, 'YYYYMMDD');
            IF to_regclass(format('%I', name)) IS NULL THEN
              EXECUTE format(
                'CREATE TABLE %I PARTITION OF "Job" FOR VALUES FROM (%L) TO (%L) WITH (fillfactor = 70)',
                name, d, d + 1
              );
            END IF;
          END LOOP;
        END;
        $$ LANGUAGE plpgsql;

        SELECT job_ensure_partitions((now() - interval '1 day')::date, 16);
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP FUNCTION IF EXISTS job_ensure_partitions(DATE, INT);
      DROP TABLE IF EXISTS "JobSchedule";
      DROP TABLE IF EXISTS "JobKey";
      DROP TABLE IF EXISTS "Job" CASCADE;
    `);
  },
};
