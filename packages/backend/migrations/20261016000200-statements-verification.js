'use strict';

/**
 * S16 reconciliation marker: when a closed month was last verified against the ledger and against itself, and how many
 * findings were open then. `AccountingPeriod` cannot hold it (a closed period never changes, by trigger), so it is a
 * table of its own, owned by `statements`, written only by `statements.verify-period`. Additive and idempotent.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "StatementVerification" (
        "month" DATE PRIMARY KEY,
        "verifiedAt" TIMESTAMPTZ NOT NULL,
        "findingsOpen" INTEGER NOT NULL DEFAULT 0
      )`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "StatementVerification"`);
  },
};
