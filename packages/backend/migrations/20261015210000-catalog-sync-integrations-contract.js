'use strict';

/**
 * S08 contract (specs/domains/S08-integrations/data-model.md "Migration order", step 3; gaps.md A16, A43). Runs after
 * the expand migration, after `scripts/catalog-sync/migrate-integrations-data.ts` and after every instance runs code
 * that no longer reads or writes `lastHash` / `lastPushedHash` nor knows a `fake` provider. Not run at startup.
 *
 *  - `Integration."provider"` check narrowed to `shopify | woocommerce`. A row that still says `fake` aborts the
 *    migration with a clear message instead of being deleted: the test-only provider never existed in production, so
 *    such a row means a wrong environment and a human must decide.
 *  - `ExternalLink."lastHash"` and `"lastPushedHash"` dropped (the old echo design, replaced by the `syncedStock` base).
 *
 * The `ERROR` status stays valid in the status check: narrowing it needs proof that the data script ran in every
 * environment, which this migration cannot see. Every statement runs under `lock_timeout = '3s'` and is idempotent.
 * `down` re-adds the columns (nullable, empty) and the wider check; the dropped hashes are not recoverable.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, options = {}) =>
        queryInterface.sequelize.query(sql, { transaction, ...options });
      await q(`SET LOCAL lock_timeout = '3s'`);

      const [fake] = await q(
        `SELECT count(*)::int AS n FROM "Integration" WHERE "provider" NOT IN ('shopify', 'woocommerce')`,
      );
      if (fake[0].n > 0) {
        throw new Error(
          `S08 contract refused: ${fake[0].n} Integration row(s) have a provider other than shopify|woocommerce`,
        );
      }

      await q(`
        ALTER TABLE "Integration" DROP CONSTRAINT IF EXISTS "Integration_provider_check";
        ALTER TABLE "Integration" ADD CONSTRAINT "Integration_provider_check"
          CHECK ("provider" IN ('shopify', 'woocommerce'));
        ALTER TABLE "ExternalLink" DROP COLUMN IF EXISTS "lastHash";
        ALTER TABLE "ExternalLink" DROP COLUMN IF EXISTS "lastPushedHash";
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        ALTER TABLE "ExternalLink" ADD COLUMN IF NOT EXISTS "lastHash" TEXT NULL;
        ALTER TABLE "ExternalLink" ADD COLUMN IF NOT EXISTS "lastPushedHash" TEXT NULL;
        ALTER TABLE "Integration" DROP CONSTRAINT IF EXISTS "Integration_provider_check";
        ALTER TABLE "Integration" ADD CONSTRAINT "Integration_provider_check"
          CHECK ("provider" IN ('shopify', 'woocommerce', 'fake'));
      `);
    });
  },
};
