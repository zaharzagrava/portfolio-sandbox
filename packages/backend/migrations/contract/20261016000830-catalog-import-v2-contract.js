'use strict';

/**
 * S07 bulk import, contract step (III.11). Shipped for a LATER release and kept in this subfolder, so `db:migrate` does
 * not run it with the expand step: run it by hand (`npx sequelize-cli db:migrate --migrations-path migrations/contract`)
 * only after no running release reads the legacy columns of "ImportJob" (`error`, `checkpointRow`, `objectKey`,
 * `uploadId`; their values live on as `failureCode`, `lastRow`, `storageKey`, `uploadHandle`, copied by the data step).
 *
 * It refuses to change anything while a legacy value has not been copied, so a half-finished data step can never lose
 * information. The foreign keys to Shop and User are already gone (expand step). Idempotent (`DROP COLUMN IF EXISTS`),
 * short lock timeout.
 */
async function hasColumn(q, name) {
  const [rows] = await q(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'ImportJob' AND column_name = '${name}'`,
  );
  return rows.length > 0;
}

async function assertSafe(q) {
  const missing = [];
  if (await hasColumn(q, 'objectKey')) {
    const [[r]] = await q(
      `SELECT count(*)::text AS n FROM "ImportJob" WHERE "objectKey" IS NOT NULL AND "storageKey" IS NULL`,
    );
    if (r.n !== '0') missing.push(`${r.n} rows with objectKey not copied to storageKey`);
  }
  if (await hasColumn(q, 'checkpointRow')) {
    const [[r]] = await q(
      `SELECT count(*)::text AS n FROM "ImportJob" WHERE "checkpointRow" <> 0 AND "lastRow" = 0`,
    );
    if (r.n !== '0') missing.push(`${r.n} rows with checkpointRow not copied to lastRow`);
  }
  if (await hasColumn(q, 'uploadId')) {
    const [[r]] = await q(
      `SELECT count(*)::text AS n FROM "ImportJob" WHERE "uploadId" IS NOT NULL AND "uploadHandle" IS NULL AND "status" = 'PENDING_UPLOAD'`,
    );
    if (r.n !== '0') missing.push(`${r.n} open uploads with uploadId not copied to uploadHandle`);
  }
  if (await hasColumn(q, 'error')) {
    const [[r]] = await q(
      `SELECT count(*)::text AS n FROM "ImportJob" WHERE "error" IS NOT NULL AND "failureCode" IS NULL`,
    );
    if (r.n !== '0') missing.push(`${r.n} rows with error not mapped to failureCode`);
  }
  if (missing.length > 0)
    throw new Error(`the import data step is not finished: ${missing.join('; ')}`);
}

module.exports = {
  assertSafe,

  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '5s'`);
      await assertSafe(q);
      await q(`ALTER TABLE "ImportJob"
        DROP COLUMN IF EXISTS "error",
        DROP COLUMN IF EXISTS "checkpointRow",
        DROP COLUMN IF EXISTS "objectKey",
        DROP COLUMN IF EXISTS "uploadId"`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '5s'`);
      await q(`ALTER TABLE "ImportJob"
        ADD COLUMN IF NOT EXISTS "error" TEXT NULL,
        ADD COLUMN IF NOT EXISTS "checkpointRow" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "objectKey" TEXT NULL,
        ADD COLUMN IF NOT EXISTS "uploadId" TEXT NULL`);
      await q(`UPDATE "ImportJob" SET "objectKey" = "storageKey", "checkpointRow" = "lastRow", "uploadId" = "uploadHandle"
               WHERE "objectKey" IS NULL`);
    });
  },
};
