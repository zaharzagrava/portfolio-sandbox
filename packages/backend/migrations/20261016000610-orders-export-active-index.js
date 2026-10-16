'use strict';

/**
 * S12: at most one QUEUED or RUNNING export per shop (FR-003). Built CONCURRENTLY, so it runs outside a transaction in
 * its own file. Legacy rows that already break the rule (several active exports of one shop, possible before this
 * change) are closed first: all but the newest become FAILED / internal_error. A half-built (INVALID) index left by an
 * interrupted earlier run is dropped before the rebuild.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`UPDATE "ExportJob" j SET "status" = 'FAILED', "failureCode" = 'internal_error', "updatedAt" = now(),
               "finishedAt" = COALESCE("finishedAt", now())
              WHERE j."status" IN ('QUEUED','RUNNING')
                AND EXISTS (SELECT 1 FROM "ExportJob" n
                             WHERE n."shopId" = j."shopId" AND n."status" IN ('QUEUED','RUNNING')
                               AND (n."createdAt", n."id") > (j."createdAt", j."id"))`);
    await q(`DO $$
             BEGIN
               IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                           WHERE c.relname = 'ux_exportjob_active_per_shop' AND NOT i.indisvalid) THEN
                 DROP INDEX "ux_exportjob_active_per_shop";
               END IF;
             END $$`);
    await q(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ux_exportjob_active_per_shop" ON "ExportJob" ("shopId") WHERE "status" IN ('QUEUED','RUNNING')`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "ux_exportjob_active_per_shop"`,
    );
  },
};
