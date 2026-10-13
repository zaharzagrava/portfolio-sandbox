'use strict';

/**
 * S14 payments, contract step (III.11): drops the legacy entries table and the retired issue kind. Deploy it in a
 * LATER release, after `ledger.backfill-balances` has finished and the invariant checker has been green: it raises
 * unless every row of "LedgerEntry_legacy" exists in "LedgerEntry" with the same id, account and amount (equal count
 * and equal checksum), so a premature run changes nothing.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);

      const [[present]] = await q(`SELECT to_regclass('"LedgerEntry_legacy"') IS NOT NULL AS present`);
      if (present.present) {
        const [[check]] = await q(`
          SELECT
            (SELECT count(*) FROM "LedgerEntry_legacy")::text AS legacy,
            (SELECT count(*) FROM "LedgerEntry_legacy" l
               JOIN "LedgerEntry" e ON e."id" = l."id" AND e."accountId" = l."accountId" AND e."amount" = l."amount")::text AS migrated,
            (SELECT coalesce(md5(string_agg(l."id"::text || ':' || l."accountId" || ':' || l."amount", ',' ORDER BY l."id")), '')
               FROM "LedgerEntry_legacy" l) AS legacy_checksum,
            (SELECT coalesce(md5(string_agg(l."id"::text || ':' || l."accountId" || ':' || l."amount", ',' ORDER BY l."id")), '')
               FROM "LedgerEntry_legacy" l
               JOIN "LedgerEntry" e ON e."id" = l."id" AND e."accountId" = l."accountId" AND e."amount" = l."amount") AS migrated_checksum
        `);
        if (check.legacy !== check.migrated || check.legacy_checksum !== check.migrated_checksum)
          throw new Error(
            `legacy ledger is not fully migrated: ${check.migrated} of ${check.legacy} rows found in "LedgerEntry", checksums ${check.migrated_checksum} / ${check.legacy_checksum}`,
          );
        await q(`DROP TABLE "LedgerEntry_legacy"`);
      }

      const [[stale]] = await q(`SELECT count(*)::text AS n FROM "ReconciliationIssue" WHERE "kind" = 'STATUS_MISMATCH'`);
      if (stale.n !== '0') throw new Error('an issue of the retired kind STATUS_MISMATCH still exists');
      await q(`ALTER TABLE "ReconciliationIssue" DROP CONSTRAINT IF EXISTS "ReconciliationIssue_kind_s14_check"`);
      await q(`
        ALTER TABLE "ReconciliationIssue" ADD CONSTRAINT "ReconciliationIssue_kind_s14_check"
          CHECK ("kind" IN ('MISSING_IN_LEDGER','MISSING_AT_PROVIDER','AMOUNT_MISMATCH','CURRENCY_MISMATCH',
                            'DUPLICATE_AT_PROVIDER','INVALID_PROVIDER_RECORD'))
      `);
    });
  },

  async down() {
    throw new Error('Irreversible: the legacy table is gone.');
  },
};
