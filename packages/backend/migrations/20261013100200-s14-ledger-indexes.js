'use strict';

/**
 * S14 payments, expand step 3: indexes, all CONCURRENTLY (so this migration runs outside any transaction).
 * Postgres cannot build an index on a partitioned table concurrently: the parent index is created `ON ONLY` (invalid
 * until every partition's index is attached), each partition's index is built concurrently and attached.
 */
const PLAIN = [
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "LedgerJournal_kind_reference_key" ON "LedgerJournal" ("kind", "reference")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "LedgerJournal_payment_idx" ON "LedgerJournal" ("paymentId") WHERE "paymentId" IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "LedgerJournal_order_kind_idx" ON "LedgerJournal" ("orderId", "kind") WHERE "orderId" IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "LedgerJournal_paymentRef_idx" ON "LedgerJournal" ("paymentRef") WHERE "paymentRef" IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "LedgerJournal_refundRef_idx" ON "LedgerJournal" ("refundRef") WHERE "refundRef" IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "LedgerJournal_kind_posted_idx" ON "LedgerJournal" ("kind", "postedAt")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountBalance_account_prefix_idx" ON "AccountBalance" ("accountId" varchar_pattern_ops)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ReconciliationIssue_run_kind_reference_key" ON "ReconciliationIssue" ("runId", "kind", "reference")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ReconciliationIssue_status_created_idx" ON "ReconciliationIssue" ("status", "createdAt" DESC, "id" DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ReconciliationIssue_day_idx" ON "ReconciliationIssue" ("day")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ReconciliationIssue_kind_status_idx" ON "ReconciliationIssue" ("kind", "status")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ReconciliationRun_started_idx" ON "ReconciliationRun" ("startedAt" DESC, "id" DESC)`,
];

const ENTRY_INDEX = 'LedgerEntry_account_shard_time_idx';
const ENTRY_COLUMNS = '("accountId", "shard", "createdAt")';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const q = (sql) => sequelize.query(sql);
    await q(`SET lock_timeout = '3s'`);
    for (const sql of PLAIN) await q(sql);

    await q(`CREATE INDEX IF NOT EXISTS "${ENTRY_INDEX}" ON ONLY "LedgerEntry" ${ENTRY_COLUMNS}`);
    const [parts] = await q(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = '"LedgerEntry"'::regclass ORDER BY c.relname`,
    );
    for (const { relname } of parts) {
      const child = `${relname}_account_shard_time_idx`;
      await q(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${child}" ON "${relname}" ${ENTRY_COLUMNS}`);
      const [attached] = await q(
        `SELECT 1 FROM pg_inherits i WHERE i.inhparent = '"${ENTRY_INDEX}"'::regclass AND i.inhrelid = '"${child}"'::regclass`,
      );
      if (attached.length === 0)
        await q(`ALTER INDEX "${ENTRY_INDEX}" ATTACH PARTITION "${child}"`);
    }
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const name of [
      'ReconciliationRun_started_idx',
      'ReconciliationIssue_kind_status_idx',
      'ReconciliationIssue_day_idx',
      'ReconciliationIssue_status_created_idx',
      'ReconciliationIssue_run_kind_reference_key',
      'AccountBalance_account_prefix_idx',
      'LedgerJournal_kind_posted_idx',
      'LedgerJournal_refundRef_idx',
      'LedgerJournal_paymentRef_idx',
      'LedgerJournal_order_kind_idx',
      'LedgerJournal_payment_idx',
      'LedgerJournal_kind_reference_key',
    ])
      await q(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    await q(`DROP INDEX IF EXISTS "${ENTRY_INDEX}"`);
  },
};
