'use strict';

/**
 * S07 bulk import: the two unique partial indexes that enforce the rules in the store (III.6, specs/domains/S07-bulk-
 * import D-03/D-04), built concurrently outside any transaction after the data step made the rows comply:
 *  - at most three non-final imports per shop, by slot (no check-then-write);
 *  - at most one import per shop that is being read (SCANNING or PROCESSING).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ux_importjob_shop_slot"
         ON "ImportJob" ("shopId", "slot")
         WHERE "status" IN ('PENDING_UPLOAD','UPLOADED','SCANNING','PROCESSING')`,
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ux_importjob_shop_running"
         ON "ImportJob" ("shopId")
         WHERE "status" IN ('SCANNING','PROCESSING')`,
    );
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "ux_importjob_shop_running"`,
    );
    await queryInterface.sequelize.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "ux_importjob_shop_slot"`,
    );
  },
};
