'use strict';

/**
 * S12 order export, contract step (III.11; specs/domains/S12-order-export/data-model.md): the columns the old
 * `OrderExportService` used (`kind`, `rows`, `error`, `objectKey`) are dropped once nothing reads or writes them.
 * Their values live on as `rowsWritten`, `failureCode` and `fileKey` (backfilled by the expand step). Idempotent
 * (`DROP COLUMN IF EXISTS`), short lock timeout.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '5s'`, {
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE "ExportJob"
           DROP COLUMN IF EXISTS "kind",
           DROP COLUMN IF EXISTS "rows",
           DROP COLUMN IF EXISTS "error",
           DROP COLUMN IF EXISTS "objectKey"`,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '5s'`, {
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE "ExportJob"
           ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'orders',
           ADD COLUMN IF NOT EXISTS "rows" INTEGER NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS "error" TEXT NULL,
           ADD COLUMN IF NOT EXISTS "objectKey" TEXT NULL`,
        { transaction },
      );
    });
  },
};
