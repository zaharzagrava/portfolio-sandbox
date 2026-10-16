'use strict';

/**
 * S07 bulk import, expand step (III.11, IX.4; specs/domains/S07-bulk-import/data-model.md). Additive and idempotent:
 * every statement is `IF NOT EXISTS`, guarded, or dropped-then-added, so a second run changes nothing. The legacy
 * columns (`error`, `checkpointRow`, `objectKey`, `uploadId`) stay for the contract step; the foreign keys to Shop and
 * User go now (new inserts must not depend on them, IX.4) and `objectKey` stops being mandatory. The unique partial
 * indexes (slot cap, one run per shop) are built concurrently by `…-catalog-import-v2-indexes.js`, after the data step.
 *
 * Each statement group runs in its own short transaction with `SET LOCAL lock_timeout`.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

const GROUPS = [
  [
    `ALTER TABLE "ImportJob"
       ADD COLUMN IF NOT EXISTS "storageKey" TEXT NULL,
       ADD COLUMN IF NOT EXISTS "uploadHandle" TEXT NULL,
       ADD COLUMN IF NOT EXISTS "slot" SMALLINT NULL,
       ADD COLUMN IF NOT EXISTS "format" TEXT NULL,
       ADD COLUMN IF NOT EXISTS "headerColumns" TEXT[] NULL,
       ADD COLUMN IF NOT EXISTS "ignoredColumns" TEXT[] NOT NULL DEFAULT '{}',
       ADD COLUMN IF NOT EXISTS "scan" TEXT NULL,
       ADD COLUMN IF NOT EXISTS "scannedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "rowsCreated" INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "rowsUpdated" INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "rowsUnchanged" INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "lastRow" INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "nextByteOffset" BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "bytesProcessed" BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "failureCode" TEXT NULL,
       ADD COLUMN IF NOT EXISTS "failureDetail" TEXT NULL,
       ADD COLUMN IF NOT EXISTS "errorReportRows" INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "leaseHolder" UUID NULL,
       ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "cancelRequestedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "lastEnqueuedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMPTZ NULL`,
  ],
  [
    `ALTER TABLE "ImportJob" DROP CONSTRAINT IF EXISTS "ImportJob_status_check"`,
    `ALTER TABLE "ImportJob" DROP CONSTRAINT IF EXISTS "ImportJob_status_widened"`,
    `ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_status_widened"
       CHECK ("status" IN ('PENDING_UPLOAD','UPLOADED','SCANNING','PROCESSING','DONE','FAILED','CANCELLED','EXPIRED'))`,
    `ALTER TABLE "ImportJob" DROP CONSTRAINT IF EXISTS "ImportJob_shopId_fkey"`,
    `ALTER TABLE "ImportJob" DROP CONSTRAINT IF EXISTS "ImportJob_createdBy_fkey"`,
    `ALTER TABLE "ImportJob" ALTER COLUMN "objectKey" DROP NOT NULL`,
  ],
  [
    // NOT VALID: legacy rows are brought in line by the data step, which then validates
    `ALTER TABLE "ImportJob" DROP CONSTRAINT IF EXISTS "ImportJob_counters_sum"`,
    `ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_counters_sum"
       CHECK ("rowsProcessed" = "rowsCreated" + "rowsUpdated" + "rowsUnchanged" + "rowsFailed") NOT VALID`,
    `ALTER TABLE "ImportJob" DROP CONSTRAINT IF EXISTS "ImportJob_size_range"`,
    `ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_size_range"
       CHECK ("sizeBytes" BETWEEN 1 AND 5368709120) NOT VALID`,
    `ALTER TABLE "ImportJob" DROP CONSTRAINT IF EXISTS "ImportJob_slot_range"`,
    `ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_slot_range" CHECK ("slot" IS NULL OR "slot" BETWEEN 1 AND 3)`,
    `ALTER TABLE "ImportJob" DROP CONSTRAINT IF EXISTS "ImportJob_failure_code"`,
    `ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_failure_code"
       CHECK ("failureCode" IS NULL OR "failureCode" IN ('malware_detected','scan_unavailable','unsupported_file_type','invalid_header','malformed_file','size_mismatch','source_missing','too_many_errors','shop_not_active','internal_error'))`,
    `ALTER TABLE "ImportJob" DROP CONSTRAINT IF EXISTS "ImportJob_format"`,
    `ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_format" CHECK ("format" IS NULL OR "format" IN ('csv','jsonl'))`,
    `ALTER TABLE "ImportJob" DROP CONSTRAINT IF EXISTS "ImportJob_scan"`,
    `ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_scan" CHECK ("scan" IS NULL OR "scan" IN ('clean','skipped'))`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS "ImportJobHistory" (
       "id" BIGSERIAL PRIMARY KEY,
       "importId" UUID NOT NULL,
       "shopId" UUID NOT NULL,
       "fromStatus" TEXT NULL,
       "toStatus" TEXT NOT NULL,
       "reason" TEXT NULL,
       "at" TIMESTAMPTZ NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS "ix_importjobhistory_import" ON "ImportJobHistory" ("importId", "id")`,
    `CREATE INDEX IF NOT EXISTS "ix_importjobhistory_shop" ON "ImportJobHistory" ("shopId")`,
  ],
  [
    `CREATE INDEX IF NOT EXISTS "ix_importjob_shop_created" ON "ImportJob" ("shopId", "createdAt" DESC, "id" DESC)`,
    `CREATE INDEX IF NOT EXISTS "ix_importjob_recovery" ON "ImportJob" ("status", "updatedAt")
       WHERE "status" IN ('UPLOADED','SCANNING','PROCESSING')`,
    `CREATE INDEX IF NOT EXISTS "ix_importjob_expiry" ON "ImportJob" ("createdAt") WHERE "status" = 'PENDING_UPLOAD'`,
    `CREATE INDEX IF NOT EXISTS "ix_importjob_finished" ON "ImportJob" ("finishedAt")
       WHERE "status" IN ('DONE','FAILED','CANCELLED','EXPIRED')`,
  ],
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
  async up(queryInterface) {
    for (const group of GROUPS) await inTransaction(queryInterface, group);
  },
  async down(queryInterface) {
    // Additions only; the previous shape is untouched. The foreign keys are not restored (rows may not satisfy them).
    await inTransaction(queryInterface, [
      `DROP TABLE IF EXISTS "ImportJobHistory"`,
      `DROP INDEX IF EXISTS "ix_importjob_finished"`,
      `DROP INDEX IF EXISTS "ix_importjob_expiry"`,
      `DROP INDEX IF EXISTS "ix_importjob_recovery"`,
      `DROP INDEX IF EXISTS "ix_importjob_shop_created"`,
    ]);
  },
};
