'use strict';

/**
 * S13 payments, expand step 4: indexes, all CONCURRENTLY (so this migration runs outside any transaction).
 *  - one payment per order (partial unique), provider reference lookup (partial unique)
 *  - keyset list per buyer; due unknown outcomes; due refunds
 * The legacy idx_payment_user_id_desc stays until the contract release.
 */
const CREATE = [
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Payment_orderId_key" ON "Payment" ("orderId") WHERE "orderId" IS NOT NULL`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Payment_providerRef_key" ON "Payment" ("providerRef") WHERE "providerRef" IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_payment_user_created" ON "Payment" ("userId", "createdAt" DESC, "id" DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_payment_unknown_due" ON "Payment" ("nextResolveAt") WHERE "status" = 'UNKNOWN'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_payment_refund_due" ON "Payment" ("refundNextAt") WHERE "status" = 'REFUND_PENDING'`,
];

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`SET lock_timeout = '3s'`);
    for (const sql of CREATE) await q(sql);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const name of [
      'idx_payment_refund_due',
      'idx_payment_unknown_due',
      'idx_payment_user_created',
      'Payment_providerRef_key',
      'Payment_orderId_key',
    ])
      await q(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
  },
};
