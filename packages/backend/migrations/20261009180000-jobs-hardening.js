'use strict';

/**
 * S49 job scheduler hardening (expand-only, III.11; data-model.md).
 *
 * Adds the columns the hardened worker and materialiser need, the indexes of the claim, list and overlap paths, and two
 * SQL functions: `job_drop_expired_partitions` (the partition drop resolved from the catalog, no application-built
 * identifier) and `job_default_partition_rows`.
 *
 * Indexes on the partitioned parent cannot be built CONCURRENTLY. At deploy time of this migration the tables are small,
 * so they are created on the parent under `lock_timeout`. For an already large table build them first per partition with
 * `CREATE INDEX CONCURRENTLY ... ON "Job_YYYYMMDD" (...)` and then `CREATE INDEX ... ON ONLY "Job"` + `ALTER INDEX ... ATTACH
 * PARTITION`; the `IF NOT EXISTS` below then finds them in place.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '5s'`);

      await q(`
        ALTER TABLE "Job"
          ADD COLUMN IF NOT EXISTS "enqueuedByRequestId" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "traceparent" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "scheduleName" TEXT NULL;

        ALTER TABLE "JobKey"
          ADD COLUMN IF NOT EXISTS "type" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now();
        CREATE INDEX IF NOT EXISTS "JobKey_createdAt_idx" ON "JobKey" ("createdAt");

        ALTER TABLE "JobSchedule"
          ADD COLUMN IF NOT EXISTS "overlap" TEXT NOT NULL DEFAULT 'skip',
          ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER NULL,
          ADD COLUMN IF NOT EXISTS "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "lastError" TEXT NULL;
      `);

      await q(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JobSchedule_overlap_check') THEN
            ALTER TABLE "JobSchedule" ADD CONSTRAINT "JobSchedule_overlap_check" CHECK ("overlap" IN ('skip', 'allow'));
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JobSchedule_maxAttempts_check') THEN
            ALTER TABLE "JobSchedule" ADD CONSTRAINT "JobSchedule_maxAttempts_check"
              CHECK ("maxAttempts" IS NULL OR ("maxAttempts" BETWEEN 1 AND 25));
          END IF;
        END $$;
      `);

      await q(`
        CREATE INDEX IF NOT EXISTS "Job_running_type_idx" ON "Job" ("type") WHERE "status" = 'RUNNING';
        CREATE INDEX IF NOT EXISTS "Job_running_shop_idx" ON "Job" ("shopId") WHERE "status" = 'RUNNING' AND "shopId" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "Job_list_idx" ON "Job" ("status", "type", "createdAt" DESC, "id" DESC);
        CREATE INDEX IF NOT EXISTS "Job_cron_active_idx" ON "Job" ("scheduleName")
          WHERE "status" IN ('QUEUED', 'RUNNING') AND "scheduleName" IS NOT NULL;
      `);

      // Drops the daily partitions that are older than retain_days and hold nothing that must survive. The partition
      // name and its day come from pg_inherits / the partition bound, never from the caller, and the identifier goes
      // through format('%I'). A partition whose lock cannot be had within lock_timeout_ms is skipped, not waited for.
      // Kept: any QUEUED or RUNNING row (a far-future schedule can sit in an old partition) and any DEAD row that
      // finished within retention (an operator may still retry it).
      await q(`
        CREATE OR REPLACE FUNCTION job_drop_expired_partitions(
          retain_days INT, lock_timeout_ms INT, now_ts TIMESTAMPTZ DEFAULT now()
        ) RETURNS SETOF TEXT AS $$
        DECLARE
          part RECORD;
          cutoff TIMESTAMPTZ := now_ts - make_interval(days => retain_days);
          busy BOOLEAN;
        BEGIN
          PERFORM set_config('lock_timeout', lock_timeout_ms::text || 'ms', true);
          FOR part IN
            SELECT c.relname::text AS name,
                   (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \\(''([^'']+)''\\)'))[1]::timestamptz AS upper_bound
            FROM pg_inherits i
            JOIN pg_class c ON c.oid = i.inhrelid
            JOIN pg_class p ON p.oid = i.inhparent
            WHERE p.relname = 'Job' AND pg_get_expr(c.relpartbound, c.oid) NOT LIKE '%DEFAULT%'
            ORDER BY c.relname
          LOOP
            CONTINUE WHEN part.upper_bound IS NULL OR part.upper_bound > cutoff;
            BEGIN
              EXECUTE format(
                'SELECT EXISTS (SELECT 1 FROM %I WHERE status IN (''QUEUED'', ''RUNNING'') OR (status = ''DEAD'' AND "finishedAt" > $1))',
                part.name
              ) INTO busy USING cutoff;
              CONTINUE WHEN busy;
              EXECUTE format('DROP TABLE %I', part.name);
              RETURN NEXT part.name;
            EXCEPTION WHEN lock_not_available THEN
              CONTINUE;
            END;
          END LOOP;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION job_default_partition_rows() RETURNS BIGINT AS $$
          SELECT count(*) FROM "Job_default";
        $$ LANGUAGE sql STABLE;
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP FUNCTION IF EXISTS job_default_partition_rows();
      DROP FUNCTION IF EXISTS job_drop_expired_partitions(INT, INT, TIMESTAMPTZ);
      DROP INDEX IF EXISTS "Job_cron_active_idx";
      DROP INDEX IF EXISTS "Job_list_idx";
      DROP INDEX IF EXISTS "Job_running_type_idx";
      ALTER TABLE "JobSchedule" DROP CONSTRAINT IF EXISTS "JobSchedule_maxAttempts_check";
      ALTER TABLE "JobSchedule" DROP CONSTRAINT IF EXISTS "JobSchedule_overlap_check";
      ALTER TABLE "JobSchedule"
        DROP COLUMN IF EXISTS "lastError", DROP COLUMN IF EXISTS "consecutiveFailures",
        DROP COLUMN IF EXISTS "maxAttempts", DROP COLUMN IF EXISTS "overlap";
      DROP INDEX IF EXISTS "JobKey_createdAt_idx";
      ALTER TABLE "JobKey" DROP COLUMN IF EXISTS "type";
      ALTER TABLE "Job"
        DROP COLUMN IF EXISTS "scheduleName", DROP COLUMN IF EXISTS "traceparent",
        DROP COLUMN IF EXISTS "enqueuedByRequestId";
    `);
  },
};
