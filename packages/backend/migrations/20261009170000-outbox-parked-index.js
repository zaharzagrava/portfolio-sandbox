'use strict';

/**
 * S53 observability (expand-only, III.11): the `outbox_parked` gauge counts parked rows after every drain; a partial
 * index keeps that count off the large published history. Built concurrently, outside a transaction.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Outbox_parked_idx" ON "Outbox" ("createdAt") WHERE "status" = 'parked'`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "Outbox_parked_idx"`);
  },
};
