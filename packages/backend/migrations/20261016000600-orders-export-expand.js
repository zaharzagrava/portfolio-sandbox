'use strict';

/**
 * S12 order export, expand step (III.11, IX.4; specs/domains/S12-order-export/data-model.md). Additive and idempotent:
 * every statement is `IF NOT EXISTS`, guarded, or `DROP ... IF EXISTS` before re-adding, so a second run changes
 * nothing. `kind`, `rows`, `error`, `objectKey` stay for the contract step; the foreign keys to Shop and User go now
 * (new inserts must not depend on them, IX.4). The unique "one active export per shop" index is built concurrently
 * in the next migration file, outside any transaction (FR-003).
 *
 * Each statement group runs in its own short transaction with `SET LOCAL lock_timeout`; the backfills run in bounded
 * batches, each its own transaction.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;
const BATCH = 1000;

const GROUPS = [
  [
    `ALTER TABLE "ExportJob"
       ADD COLUMN IF NOT EXISTS "attempt" INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "totalRows" BIGINT NULL,
       ADD COLUMN IF NOT EXISTS "rowsWritten" BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "bytesWritten" BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "failureCode" TEXT NULL,
       ADD COLUMN IF NOT EXISTS "fileKey" TEXT NULL,
       ADD COLUMN IF NOT EXISTS "leaseHolder" UUID NULL,
       ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ NULL`,
  ],
  [
    `ALTER TABLE "ExportJob" DROP CONSTRAINT IF EXISTS "ExportJob_status_check"`,
    `ALTER TABLE "ExportJob" DROP CONSTRAINT IF EXISTS "ExportJob_status_widened"`,
    `ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_status_widened"
       CHECK ("status" IN ('QUEUED','RUNNING','DONE','FAILED','CANCELLED','EXPIRED'))`,
    `ALTER TABLE "ExportJob" ALTER COLUMN "status" SET DEFAULT 'QUEUED'`,
    `ALTER TABLE "ExportJob" DROP CONSTRAINT IF EXISTS "ExportJob_shopId_fkey"`,
    `ALTER TABLE "ExportJob" DROP CONSTRAINT IF EXISTS "ExportJob_createdBy_fkey"`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS "ExportJobHistory" (
       "id" UUID PRIMARY KEY DEFAULT uuidv7(),
       "exportId" UUID NOT NULL,
       "shopId" UUID NOT NULL,
       "fromStatus" TEXT NULL,
       "toStatus" TEXT NOT NULL,
       "reason" TEXT NULL,
       "actor" UUID NULL,
       "at" TIMESTAMPTZ NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS "ix_exportjobhistory_export_at" ON "ExportJobHistory" ("exportId", "at")`,
    `CREATE INDEX IF NOT EXISTS "ix_exportjobhistory_shop" ON "ExportJobHistory" ("shopId")`,
  ],
  [
    `CREATE INDEX IF NOT EXISTS "ix_exportjob_shop_created" ON "ExportJob" ("shopId", "createdAt" DESC, "id" DESC)`,
    `CREATE INDEX IF NOT EXISTS "ix_exportjob_lease" ON "ExportJob" ("leaseExpiresAt") WHERE "status" = 'RUNNING'`,
    `CREATE INDEX IF NOT EXISTS "ix_exportjob_finished" ON "ExportJob" ("finishedAt")
       WHERE "status" IN ('DONE','FAILED','CANCELLED','EXPIRED')`,
  ],
];

/** One bounded batch per statement; each returns how many rows it changed. */
const BACKFILLS = [
  `WITH b AS (SELECT "id" FROM "ExportJob" WHERE "rowsWritten" = 0 AND "rows" <> 0 ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
   UPDATE "ExportJob" j SET "rowsWritten" = j."rows" FROM b WHERE j."id" = b."id"`,
  `WITH b AS (SELECT "id" FROM "ExportJob" WHERE "status" = 'FAILED' AND "failureCode" IS NULL ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
   UPDATE "ExportJob" j SET "failureCode" = 'internal_error' FROM b WHERE j."id" = b."id"`,
  `WITH b AS (SELECT "id" FROM "ExportJob" WHERE "status" = 'RUNNING' AND "leaseExpiresAt" IS NULL ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
   UPDATE "ExportJob" j SET "leaseExpiresAt" = now() FROM b WHERE j."id" = b."id"`,
];

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
  BACKFILLS,
  async up(queryInterface) {
    for (const group of GROUPS) await inTransaction(queryInterface, group);
    // After the contract step the legacy `rows` column is gone and so is the row to backfill from.
    const [legacy] = await queryInterface.sequelize.query(
      `SELECT 1 AS present FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'ExportJob' AND column_name = 'rows'`,
    );
    for (const sql of legacy.length > 0 ? BACKFILLS : BACKFILLS.slice(1)) {
      for (;;) {
        const changed = await queryInterface.sequelize.transaction(
          async (transaction) => {
            const [, meta] = await queryInterface.sequelize.query(sql, {
              transaction,
            });
            return meta && typeof meta.rowCount === 'number'
              ? meta.rowCount
              : 0;
          },
        );
        if (changed === 0) break;
      }
    }
  },
  async down(queryInterface) {
    // Additions only; the previous shape is untouched. The foreign keys are not restored (rows may not satisfy them).
    await inTransaction(queryInterface, [
      `DROP TABLE IF EXISTS "ExportJobHistory"`,
      `DROP INDEX IF EXISTS "ix_exportjob_finished"`,
      `DROP INDEX IF EXISTS "ix_exportjob_lease"`,
      `DROP INDEX IF EXISTS "ix_exportjob_shop_created"`,
    ]);
  },
};
