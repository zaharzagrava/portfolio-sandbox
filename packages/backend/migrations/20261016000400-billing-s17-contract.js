'use strict';

/**
 * S17 subscriptions, contract step (III.11): drops what only the previous release read. Runs after the expand code is
 * deployed everywhere. The old unique `(subscriptionId, periodStart, kind)` was already dropped by the expand step
 * (the business key replaces it and two changes at one instant must not collide); what is left is the old due index,
 * replaced by the partial `Subscription_run_due_idx` that excludes delinquent subscriptions.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '5s'`, { transaction });
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "Subscription_due_idx"`, { transaction });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS "Subscription_due_idx" ON "Subscription" ("currentPeriodEnd")
           WHERE "status" IN ('TRIALING','ACTIVE','PAST_DUE')`,
        { transaction },
      );
    });
  },
};
