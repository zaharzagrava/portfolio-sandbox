'use strict';

/**
 * S29 photos, expand step (III.11, never run at application start; specs/domains/S29-photos/research.md R-12 step 1).
 * Backward compatible: the new columns have defaults, the old columns stay, the status CHECK is replaced by a superset.
 * New: the lease / attempt / version columns of `Media`, the `MediaStatusHistory` and `ProductGallery` tables, the
 * product-only band indexes, and the deferrable `(productId, position)` uniqueness of `ProductMedia`. The foreign keys
 * and `rejectReason` go in the contract step, after the new code is deployed.
 *
 * The purpose CHECK (`post` removed) is added NOT VALID here and validated by the backfill, after the legacy `post`
 * rows were retired. Indexes are built CONCURRENTLY, outside any transaction.
 */
const STATUSES = `'PENDING_UPLOAD', 'UPLOADED', 'PROCESSING', 'READY', 'REJECTED', 'EXPIRED', 'DELETED'`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        ALTER TABLE "Media"
          ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
          ADD COLUMN IF NOT EXISTS "rejectCode" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "uploadedAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "duplicateDistance" SMALLINT NULL,
          ADD COLUMN IF NOT EXISTS "duplicateAt" TIMESTAMPTZ NULL
      `);
      // Seven statuses instead of four; NOT VALID is enough, the old rows already satisfy the superset (validated in
      // the backfill). The purpose CHECK drops `post`; existing `post` rows are retired by the backfill first.
      await q(`ALTER TABLE "Media" DROP CONSTRAINT IF EXISTS "Media_status_check"`);
      await q(
        `ALTER TABLE "Media" ADD CONSTRAINT "Media_status_check" CHECK ("status" IN (${STATUSES})) NOT VALID`,
      );
      await q(`ALTER TABLE "Media" DROP CONSTRAINT IF EXISTS "Media_purpose_check"`);
      await q(
        `ALTER TABLE "Media" ADD CONSTRAINT "Media_purpose_check" CHECK ("purpose" IN ('product', 'review')) NOT VALID`,
      );
      await q(`
        CREATE TABLE IF NOT EXISTS "MediaStatusHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "mediaId" UUID NOT NULL,
          "fromStatus" TEXT NULL CHECK ("fromStatus" IN (${STATUSES})),
          "toStatus" TEXT NOT NULL CHECK ("toStatus" IN (${STATUSES})),
          "actorType" TEXT NOT NULL CHECK ("actorType" IN ('user', 'system', 'worker')),
          "actorId" UUID NULL,
          "rejectCode" TEXT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "MediaStatusHistory_media_idx" ON "MediaStatusHistory" ("mediaId", "createdAt");

        CREATE TABLE IF NOT EXISTS "ProductGallery" (
          "productId" UUID PRIMARY KEY,
          "shopId" UUID NOT NULL,
          "version" INTEGER NOT NULL DEFAULT 0,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "ProductGallery_shop_idx" ON "ProductGallery" ("shopId");
      `);
      await q(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProductMedia_product_position_uq') THEN
            ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_product_position_uq"
              UNIQUE ("productId", "position") DEFERRABLE INITIALLY DEFERRED;
          END IF;
        END $$;
      `);
      await q(`CREATE INDEX IF NOT EXISTS "ProductMedia_media_idx" ON "ProductMedia" ("mediaId")`);
    });

    // A failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would skip: drop those first.
    const concurrently = [
      [`Media_uploader_status_idx`, `("uploaderId", "status")`, ''],
      [`Media_shop_idx`, `("shopId")`, ''],
      [`Media_uploaded_idx`, `("status", "uploadedAt")`, `WHERE "status" = 'UPLOADED'`],
      [`Media_lease_idx`, `("leaseUntil")`, `WHERE "status" = 'PROCESSING'`],
      [
        `Media_terminal_idx`,
        `("status", "updatedAt")`,
        `WHERE "status" IN ('REJECTED', 'EXPIRED', 'DELETED')`,
      ],
      ...[0, 1, 2, 3].map((i) => [
        `Media_product_b${i}`,
        `("dhashB${i}")`,
        `WHERE "status" = 'READY' AND "purpose" = 'product'`,
      ]),
    ];
    for (const [name, columns, where] of concurrently) {
      const [state] = await sequelize.query(
        `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = '${name}'`,
        { type: 'SELECT' },
      );
      if (state && !state.valid)
        await sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
      await sequelize.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "Media" ${columns} ${where}`,
      );
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const name of [
      'Media_uploader_status_idx',
      'Media_shop_idx',
      'Media_uploaded_idx',
      'Media_lease_idx',
      'Media_terminal_idx',
      'Media_product_b0',
      'Media_product_b1',
      'Media_product_b2',
      'Media_product_b3',
    ])
      await sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`DROP INDEX IF EXISTS "ProductMedia_media_idx"`);
      await q(
        `ALTER TABLE "ProductMedia" DROP CONSTRAINT IF EXISTS "ProductMedia_product_position_uq"`,
      );
      await q(`DROP TABLE IF EXISTS "ProductGallery", "MediaStatusHistory"`);
      await q(`ALTER TABLE "Media" DROP CONSTRAINT IF EXISTS "Media_status_check"`);
      await q(
        `ALTER TABLE "Media" ADD CONSTRAINT "Media_status_check" CHECK ("status" IN ('PENDING_UPLOAD', 'PROCESSING', 'READY', 'REJECTED')) NOT VALID`,
      );
      await q(`ALTER TABLE "Media" DROP CONSTRAINT IF EXISTS "Media_purpose_check"`);
      await q(
        `ALTER TABLE "Media" ADD CONSTRAINT "Media_purpose_check" CHECK ("purpose" IN ('product', 'review', 'post')) NOT VALID`,
      );
      await q(`
        ALTER TABLE "Media"
          DROP COLUMN IF EXISTS "attempts",
          DROP COLUMN IF EXISTS "leaseUntil",
          DROP COLUMN IF EXISTS "version",
          DROP COLUMN IF EXISTS "rejectCode",
          DROP COLUMN IF EXISTS "uploadedAt",
          DROP COLUMN IF EXISTS "duplicateDistance",
          DROP COLUMN IF EXISTS "duplicateAt"
      `);
    });
  },
};
