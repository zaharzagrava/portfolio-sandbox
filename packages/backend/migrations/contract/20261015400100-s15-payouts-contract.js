'use strict';

/**
 * S15 payouts, contract step (III.11). Shipped for a LATER release and kept in this subfolder, so `db:migrate` does not
 * run it with the expand step: run it by hand (`npx sequelize-cli db:migrate --migrations-path migrations/contract`)
 * only after the code stopped writing `amount` and `providerRef` and AS-53's checks were green on the target database.
 *
 * It refuses to change anything unless the new columns carry exactly what the old ones do: every payout has an
 * `amountMinor`, the sums of `amount` and `amountMinor` are equal, and every non-null `providerRef` equals the
 * `transferRef`. Then `amountMinor` becomes NOT NULL and the legacy columns, the dual-write trigger and the superseded
 * `ProviderAccount` table (S14) are dropped. Tenancy drops `Shop.stripeAccountId` in its own contract step.
 */
async function assertSafe(q) {
  const [[check]] = await q(`
    SELECT
      (SELECT count(*) FROM "Payout")::text AS total,
      (SELECT count(*) FROM "Payout" WHERE "amountMinor" IS NOT NULL)::text AS migrated,
      (SELECT coalesce(sum("amount"), 0) FROM "Payout")::text AS legacy_sum,
      (SELECT coalesce(sum("amountMinor"), 0) FROM "Payout")::text AS new_sum,
      (SELECT count(*) FROM "Payout"
        WHERE "providerRef" IS NOT NULL AND "providerRef" IS DISTINCT FROM "transferRef")::text AS unmatched_refs
  `);
  if (check.total !== check.migrated)
    throw new Error(`${check.total - check.migrated} payouts have no amountMinor yet`);
  if (check.legacy_sum !== check.new_sum)
    throw new Error(`amount (${check.legacy_sum}) and amountMinor (${check.new_sum}) do not add up to the same total`);
  if (check.unmatched_refs !== '0')
    throw new Error(`${check.unmatched_refs} payouts have a providerRef that differs from transferRef`);
}

module.exports = {
  assertSafe,

  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await assertSafe(q);
      await q(`
        DROP TRIGGER IF EXISTS payout_dual_write ON "Payout";
        DROP FUNCTION IF EXISTS payout_dual_write();
        ALTER TABLE "Payout" ALTER COLUMN "amountMinor" SET NOT NULL;
        ALTER TABLE "Payout" DROP COLUMN IF EXISTS "amount";
        ALTER TABLE "Payout" DROP COLUMN IF EXISTS "providerRef";
        DROP TABLE IF EXISTS "ProviderAccount";
      `);
    });
  },

  async down() {
    throw new Error('Irreversible: the legacy columns are gone.');
  },
};
