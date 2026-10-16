'use strict';

/**
 * S04 seller onboarding, expand step (III.11, R-11; specs/domains/S04-kyc-onboarding/data-model.md). Additive and
 * idempotent; the history of `20261002170000-seller-onboarding.js` stays untouched and no `Shop` column is touched
 * (they belong to tenancy, A35). Every statement group runs in its own short transaction with `SET LOCAL lock_timeout`;
 * the indexes are built `CONCURRENTLY` outside any transaction, after the backfill.
 *
 * The foreign keys to "Shop" and the old unique `(shopId, kind, contentHash)` go in the next migration
 * (`...-seller-onboarding-s04-contract.js`), once the code that does not need them is in.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

const GROUPS = [
  [
    `ALTER TABLE "ShopOnboarding"
       ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
       ADD COLUMN IF NOT EXISTS "submissionNo" INTEGER NOT NULL DEFAULT 1,
       ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "rejectionReasonCode" TEXT NULL,
       ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT NULL`,
    `ALTER TABLE "ShopOnboarding" DROP CONSTRAINT IF EXISTS "ShopOnboarding_status_check"`,
    `ALTER TABLE "ShopOnboarding" ADD CONSTRAINT "ShopOnboarding_status_check"
       CHECK ("status" IN ('SUBMITTED', 'VERIFIED', 'REJECTED'))`,
    `ALTER TABLE "ShopOnboarding" DROP CONSTRAINT IF EXISTS "ShopOnboarding_submission_no"`,
    `ALTER TABLE "ShopOnboarding" ADD CONSTRAINT "ShopOnboarding_submission_no" CHECK ("submissionNo" >= 1)`,
    `ALTER TABLE "ShopOnboarding" DROP CONSTRAINT IF EXISTS "ShopOnboarding_rejection_code"`,
    `ALTER TABLE "ShopOnboarding" ADD CONSTRAINT "ShopOnboarding_rejection_code"
       CHECK ("rejectionReasonCode" IS NULL OR "rejectionReasonCode" IN ('DOCUMENTS_INVALID', 'IDENTITY_MISMATCH', 'FRAUD_SUSPECTED', 'OTHER'))`,
    `ALTER TABLE "ShopOnboarding" DROP CONSTRAINT IF EXISTS "ShopOnboarding_rejection_reason"`,
    `ALTER TABLE "ShopOnboarding" ADD CONSTRAINT "ShopOnboarding_rejection_reason"
       CHECK ("rejectionReason" IS NULL OR char_length("rejectionReason") BETWEEN 3 AND 500)`,
  ],
  [
    `ALTER TABLE "ShopDocument"
       ADD COLUMN IF NOT EXISTS "submissionNo" INTEGER NOT NULL DEFAULT 1,
       ADD COLUMN IF NOT EXISTS "size" INTEGER NULL,
       ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "purgedAt" TIMESTAMPTZ NULL`,
    `ALTER TABLE "ShopDocument" DROP CONSTRAINT IF EXISTS "ShopDocument_submission_no"`,
    `ALTER TABLE "ShopDocument" ADD CONSTRAINT "ShopDocument_submission_no" CHECK ("submissionNo" >= 1)`,
  ],
  [
    `ALTER TABLE "ReviewTask"
       ADD COLUMN IF NOT EXISTS "corrections" JSONB NULL,
       ADD COLUMN IF NOT EXISTS "resolvedBy" UUID NULL,
       ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMPTZ NULL`,
    `ALTER TABLE "ReviewTask" DROP CONSTRAINT IF EXISTS "ReviewTask_status_check"`,
    `ALTER TABLE "ReviewTask" DROP CONSTRAINT IF EXISTS "ReviewTask_status_widened"`,
    `ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_status_widened"
       CHECK ("status" IN ('OPEN', 'APPROVED', 'REJECTED', 'CANCELLED'))`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS "OnboardingStatusHistory" (
       "id" UUID PRIMARY KEY DEFAULT uuidv7(),
       "entity" TEXT NOT NULL CHECK ("entity" IN ('APPLICATION', 'DOCUMENT')),
       "entityId" UUID NOT NULL,
       "shopId" UUID NOT NULL,
       "fromStatus" TEXT NULL,
       "toStatus" TEXT NOT NULL,
       "actor" TEXT NOT NULL,
       "reasonCode" TEXT NULL,
       "at" TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  ],
];

/** Backfill in this domain's own data only: an application with a `verifiedAt` is VERIFIED (never derived from "Shop"). */
const BACKFILL = [
  `UPDATE "ShopOnboarding" SET "status" = 'VERIFIED' WHERE "verifiedAt" IS NOT NULL AND "status" = 'SUBMITTED'`,
];

const INDEXES = [
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ux_shopdocument_round_kind_hash"
     ON "ShopDocument" ("shopId", "submissionNo", "kind", "contentHash")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_shopdocument_round_kind"
     ON "ShopDocument" ("shopId", "submissionNo", "kind")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_shopdocument_lease"
     ON "ShopDocument" ("status", "leaseUntil") WHERE "status" = 'EXTRACTING'`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ReviewTask_one_open_per_document"
     ON "ReviewTask" ("documentId") WHERE "status" = 'OPEN'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_reviewtask_open_keyset"
     ON "ReviewTask" ("createdAt", "id") WHERE "status" = 'OPEN'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_reviewtask_open_shop"
     ON "ReviewTask" ("shopId") WHERE "status" = 'OPEN'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_onboardingstatushistory_entity"
     ON "OnboardingStatusHistory" ("entity", "entityId", "at")`,
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const group of GROUPS) {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(LOCK_TIMEOUT, { transaction });
        for (const statement of group) await sequelize.query(statement, { transaction });
      });
    }
    for (const statement of BACKFILL) await sequelize.query(statement);
    // CONCURRENTLY cannot run inside a transaction. (documentId, attempt) is already the primary key of "DocumentExtraction".
    for (const statement of INDEXES) await sequelize.query(statement);
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const name of [
      'ix_onboardingstatushistory_entity',
      'ix_reviewtask_open_shop',
      'ix_reviewtask_open_keyset',
      'ix_shopdocument_lease',
      'ix_shopdocument_round_kind',
      'ux_shopdocument_round_kind_hash',
    ])
      await sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(LOCK_TIMEOUT, { transaction });
      await sequelize.query(
        `DROP TABLE IF EXISTS "OnboardingStatusHistory";
         ALTER TABLE "ReviewTask" DROP CONSTRAINT IF EXISTS "ReviewTask_status_widened";
         UPDATE "ReviewTask" SET "status" = 'REJECTED' WHERE "status" = 'CANCELLED';
         ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_status_check" CHECK ("status" IN ('OPEN', 'APPROVED', 'REJECTED'));
         ALTER TABLE "ShopDocument" DROP CONSTRAINT IF EXISTS "ShopDocument_submission_no",
           DROP COLUMN IF EXISTS "submissionNo", DROP COLUMN IF EXISTS "size", DROP COLUMN IF EXISTS "leaseUntil";
         ALTER TABLE "ShopOnboarding" DROP CONSTRAINT IF EXISTS "ShopOnboarding_status_check",
           DROP CONSTRAINT IF EXISTS "ShopOnboarding_submission_no",
           DROP CONSTRAINT IF EXISTS "ShopOnboarding_rejection_code",
           DROP CONSTRAINT IF EXISTS "ShopOnboarding_rejection_reason",
           DROP COLUMN IF EXISTS "status", DROP COLUMN IF EXISTS "submissionNo", DROP COLUMN IF EXISTS "rejectedAt",
           DROP COLUMN IF EXISTS "rejectionReasonCode", DROP COLUMN IF EXISTS "rejectionReason"`,
        { transaction },
      );
    });
  },
};
