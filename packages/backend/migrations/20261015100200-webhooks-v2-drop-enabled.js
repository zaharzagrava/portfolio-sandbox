'use strict';

/**
 * S43 contract, step 2 (data-model.md, research.md R-15): the boolean `enabled` and everything that kept it in step with
 * `status` go, now that no code reads or writes it (the dashboard service, the router's reads and the deliverer's reads all
 * use `status`). Runs after `20261015100000-webhooks-v2.js` (which added `status` and the transitional trigger) and
 * `20261015100100-webhooks-v2-contract.js`. Every statement runs under `lock_timeout = '3s'` and is idempotent.
 *
 *  - drops the transitional trigger `WebhookEndpoint_compat_trg` and its function
 *  - drops the old indexes on the boolean (`WebhookEndpoint_shop_idx`, `WebhookEndpoint_failing_idx`), replaced by the
 *    partial routing and sweep indexes of the expand step
 *  - drops the column `enabled`
 *  - adds the check that `disabledReason` is `manual` or `auto_failing` (or null when enabled)
 *
 * `down` re-adds `enabled` (backfilled from `status`) and drops the check; it does not recreate the trigger.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        DROP TRIGGER IF EXISTS "WebhookEndpoint_compat_trg" ON "WebhookEndpoint";
        DROP FUNCTION IF EXISTS "WebhookEndpoint_compat"();
        DROP INDEX IF EXISTS "WebhookEndpoint_shop_idx";
        DROP INDEX IF EXISTS "WebhookEndpoint_failing_idx";
        ALTER TABLE "WebhookEndpoint" DROP COLUMN IF EXISTS "enabled";
        UPDATE "WebhookEndpoint" SET "disabledReason" = 'auto_failing'
         WHERE "status" = 'disabled' AND "disabledReason" IS NOT NULL AND "disabledReason" NOT IN ('manual', 'auto_failing');
        ALTER TABLE "WebhookEndpoint" DROP CONSTRAINT IF EXISTS "WebhookEndpoint_disabled_reason_chk";
        ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_disabled_reason_chk"
          CHECK ("disabledReason" IS NULL OR "disabledReason" IN ('manual', 'auto_failing'));
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        ALTER TABLE "WebhookEndpoint" DROP CONSTRAINT IF EXISTS "WebhookEndpoint_disabled_reason_chk";
        ALTER TABLE "WebhookEndpoint" ADD COLUMN IF NOT EXISTS "enabled" BOOLEAN NOT NULL DEFAULT true;
        UPDATE "WebhookEndpoint" SET "enabled" = ("status" = 'enabled');
      `);
    });
  },
};
