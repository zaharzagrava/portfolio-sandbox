'use strict';

/**
 * S53 outbox row contract (expand-only, III.11). A framework-free writer (Lambda, Rust gateway) follows this table
 * alone, so the database rejects what the contract forbids:
 *  - `kind` event | task, `status` pending | published | parked
 *  - a message key (`aggregateId`, never empty)
 *  - for events: `aggregateType`, a lowercase dotted `type`, and a payload that is an envelope (`eventId` present)
 * New CHECKs are `NOT VALID` (enforced for every later insert/update, history is not scanned); a later migration
 * validates them once the legacy rows are gone. Legacy columns (`eventName`, `extra`, `error`) stay until the
 * contract migration; `eventName` is still written (= `type`) so readers of it keep working.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run(`SET LOCAL lock_timeout = '5s'`);
      await run(`
        ALTER TABLE "Outbox"
          ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'event',
          ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'pending',
          ADD COLUMN IF NOT EXISTS "aggregateType" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "type" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "parkedReason" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMPTZ NULL;
      `);
      // Backfill before the constraints exist: published rows are published; rows that never reached the log and
      // are not envelopes of the new shape are parked (reason LEGACY_SHAPE) so the relay never publishes them.
      await run(`
        UPDATE "Outbox" SET
          "type" = COALESCE("type", "eventName", "payload"->>'type'),
          "aggregateType" = COALESCE("aggregateType", "payload"->>'aggregateType', NULLIF(regexp_replace("topic", '\\.events$', ''), "topic"))
        WHERE "type" IS NULL OR "aggregateType" IS NULL;
        UPDATE "Outbox" SET "status" = 'published' WHERE "publishedAt" IS NOT NULL AND "status" = 'pending';
        UPDATE "Outbox" SET "status" = 'parked', "parkedReason" = 'LEGACY_SHAPE'
          WHERE "status" = 'pending'
            AND ("aggregateId" IS NULL OR "type" IS NULL OR "aggregateType" IS NULL OR NOT ("payload" ? 'eventId') OR "payload" ? 'eventName');
      `);
      await run(`
        ALTER TABLE "Outbox"
          ADD CONSTRAINT "Outbox_kind_chk" CHECK ("kind" IN ('event', 'task')) NOT VALID,
          ADD CONSTRAINT "Outbox_status_chk" CHECK ("status" IN ('pending', 'published', 'parked')) NOT VALID,
          ADD CONSTRAINT "Outbox_key_chk" CHECK ("aggregateId" IS NOT NULL AND "aggregateId" <> '') NOT VALID,
          ADD CONSTRAINT "Outbox_event_chk" CHECK (
            "kind" <> 'event' OR (
              "aggregateType" IS NOT NULL AND "aggregateType" <> ''
              AND "type" ~ '^[a-z][a-z0-9]*(\\.[a-z][a-z0-9_]*)+$'
              AND jsonb_typeof("payload") = 'object' AND "payload" ? 'eventId'
            )
          ) NOT VALID;
      `);
    });
    // Indexes outside a transaction, one by one, without blocking writers.
    const index = (sql) => queryInterface.sequelize.query(sql);
    await index(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "Outbox_pending_due_idx" ON "Outbox" ("nextAttemptAt") WHERE "status" = 'pending'`);
    await index(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "Outbox_aggregate_idx" ON "Outbox" ("aggregateId", "createdAt")`);
    await index(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "Outbox_published_idx" ON "Outbox" ("publishedAt") WHERE "status" = 'published'`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "Outbox_published_idx";
      DROP INDEX IF EXISTS "Outbox_aggregate_idx";
      DROP INDEX IF EXISTS "Outbox_pending_due_idx";
      ALTER TABLE "Outbox"
        DROP CONSTRAINT IF EXISTS "Outbox_event_chk",
        DROP CONSTRAINT IF EXISTS "Outbox_key_chk",
        DROP CONSTRAINT IF EXISTS "Outbox_status_chk",
        DROP CONSTRAINT IF EXISTS "Outbox_kind_chk",
        DROP COLUMN IF EXISTS "leaseUntil",
        DROP COLUMN IF EXISTS "parkedReason",
        DROP COLUMN IF EXISTS "type",
        DROP COLUMN IF EXISTS "aggregateType",
        DROP COLUMN IF EXISTS "status",
        DROP COLUMN IF EXISTS "kind";
    `);
  },
};
