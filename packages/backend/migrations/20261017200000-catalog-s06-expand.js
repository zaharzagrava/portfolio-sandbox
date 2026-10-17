'use strict';

/**
 * S06 collaborative drafts, expand step (III.11; specs/domains/S06-collab-editor/data-model.md). Additive and idempotent;
 * the old draft code keeps working until the services are rewritten. Each group runs in its own short transaction with
 * `SET LOCAL lock_timeout`; the indexes are built outside any transaction, `CONCURRENTLY`.
 *
 *  - "ListingDraft": baseProductVersion, publishLeaseId, publishLeaseExpiresAt; status CHECK widened with `PUBLISHING`.
 *  - "ListingDraftVersion": shopId (denormalised so every predicate carries the shop; backfilled from the draft) and kind.
 *  - Indexes for the keyset list, the open-draft count, the stale-lease job and the version list.
 *
 * The foreign keys to "Shop" and "User" go in `20261017200100-catalog-s06-contract.js` (the one to "Product" is already
 * gone, S05).
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

const GROUPS = [
  [
    `ALTER TABLE "ListingDraft"
       ADD COLUMN IF NOT EXISTS "baseProductVersion" INTEGER NULL,
       ADD COLUMN IF NOT EXISTS "publishLeaseId" UUID NULL,
       ADD COLUMN IF NOT EXISTS "publishLeaseExpiresAt" TIMESTAMPTZ NULL`,
    `DO $$
     DECLARE c text;
     BEGIN
       FOR c IN
         SELECT conname FROM pg_constraint
         WHERE conrelid = '"ListingDraft"'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%status%'
       LOOP
         EXECUTE format('ALTER TABLE "ListingDraft" DROP CONSTRAINT %I', c);
       END LOOP;
     END $$`,
    `ALTER TABLE "ListingDraft" ADD CONSTRAINT "ListingDraft_status_check"
       CHECK ("status" IN ('DRAFT', 'PUBLISHING', 'PUBLISHED', 'ARCHIVED'))`,
  ],
  [
    `ALTER TABLE "ListingDraftVersion"
       ADD COLUMN IF NOT EXISTS "shopId" UUID NULL,
       ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'named'`,
    `UPDATE "ListingDraftVersion" v SET "shopId" = d."shopId"
       FROM "ListingDraft" d WHERE d."id" = v."draftId" AND v."shopId" IS NULL`,
    `ALTER TABLE "ListingDraftVersion" ALTER COLUMN "shopId" SET NOT NULL`,
    `ALTER TABLE "ListingDraftVersion" DROP CONSTRAINT IF EXISTS "ListingDraftVersion_kind_check"`,
    `ALTER TABLE "ListingDraftVersion" ADD CONSTRAINT "ListingDraftVersion_kind_check"
       CHECK ("kind" IN ('named', 'published'))`,
  ],
];

const INDEXES = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ListingDraft_shop_updated_idx"
     ON "ListingDraft" ("shopId", "updatedAt" DESC, "id" DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ListingDraft_open_idx"
     ON "ListingDraft" ("shopId") WHERE "status" IN ('DRAFT', 'PUBLISHING')`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ListingDraft_lease_idx"
     ON "ListingDraft" ("publishLeaseExpiresAt") WHERE "status" = 'PUBLISHING'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ListingDraftVersion_draft_created_idx"
     ON "ListingDraftVersion" ("draftId", "createdAt" DESC, "id" DESC)`,
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const group of GROUPS) {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(LOCK_TIMEOUT, { transaction });
        for (const sql of group) await sequelize.query(sql, { transaction });
      });
    }
    for (const sql of INDEXES) await sequelize.query(sql);
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query(`
      DROP INDEX IF EXISTS "ListingDraft_shop_updated_idx";
      DROP INDEX IF EXISTS "ListingDraft_open_idx";
      DROP INDEX IF EXISTS "ListingDraft_lease_idx";
      DROP INDEX IF EXISTS "ListingDraftVersion_draft_created_idx";
      ALTER TABLE "ListingDraftVersion" DROP COLUMN IF EXISTS "kind", DROP COLUMN IF EXISTS "shopId";
      ALTER TABLE "ListingDraft"
        DROP COLUMN IF EXISTS "baseProductVersion",
        DROP COLUMN IF EXISTS "publishLeaseId",
        DROP COLUMN IF EXISTS "publishLeaseExpiresAt";
    `);
  },
};
