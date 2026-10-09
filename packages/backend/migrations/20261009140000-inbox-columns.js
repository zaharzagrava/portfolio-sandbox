'use strict';

/**
 * S53 inbox: `ProcessedWebhookEvent` becomes the inbox table (owner `infrastructure:inbox`, name kept, IX.2).
 * Expand-only (III.11). The existing `provider` column is the inbox `source` (the model maps `source` onto it, the
 * raw SQL of the Stripe webhook keeps working until S10 moves it to `InboxService`) and the primary key
 * `(provider, eventId)` is the atomic claim. Rows written before this migration are processed events: they keep
 * the default status `PROCESSED`.
 *   status   RECEIVED | PROCESSED | IGNORED | UNMATCHED | REJECTED | FAILED
 *   attempts handling attempts so far (claim increments it)
 *   claimedAt start of the current attempt (the 5-minute claim lease runs from it)
 *   handledAt when a terminal status was set; detail a short reason code, never a payload value
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run(`SET LOCAL lock_timeout = '5s'`);
      await run(`
        ALTER TABLE "ProcessedWebhookEvent"
          ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PROCESSED',
          ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 1,
          ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "handledAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          ADD COLUMN IF NOT EXISTS "detail" TEXT NULL;
        ALTER TABLE "ProcessedWebhookEvent"
          ADD CONSTRAINT "ProcessedWebhookEvent_status_chk"
          CHECK ("status" IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'UNMATCHED', 'REJECTED', 'FAILED')) NOT VALID;
      `);
    });
    await queryInterface.sequelize.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ProcessedWebhookEvent_purge_idx"
         ON "ProcessedWebhookEvent" ((COALESCE("handledAt", "processedAt")))
         WHERE "status" IN ('PROCESSED', 'IGNORED', 'UNMATCHED', 'REJECTED')`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "ProcessedWebhookEvent_purge_idx";
      ALTER TABLE "ProcessedWebhookEvent"
        DROP CONSTRAINT IF EXISTS "ProcessedWebhookEvent_status_chk",
        DROP COLUMN IF EXISTS "detail",
        DROP COLUMN IF EXISTS "createdAt",
        DROP COLUMN IF EXISTS "handledAt",
        DROP COLUMN IF EXISTS "claimedAt",
        DROP COLUMN IF EXISTS "attempts",
        DROP COLUMN IF EXISTS "status";
    `);
  },
};
