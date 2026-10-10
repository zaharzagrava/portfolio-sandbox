'use strict';

/**
 * S10 orders, expand step 2: indexes, all CONCURRENTLY (so this migration runs outside any transaction).
 *  - history: keyset over (userId, createdAt, id), covering status/total/currency, hiding out-of-stock cancellations;
 *    replaces the old (userId, createdAt) index
 *  - sweeper: RESERVED holds by deadline; recovery: PENDING orders by age
 *  - seller list, timeline, release job
 *  - one reservation per product and order
 */
const CREATE = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "BisOrder_user_history_v2_idx" ON "BisOrder" ("userId", "createdAt" DESC, "id" DESC)
     INCLUDE ("status", "total", "currency")
     WHERE NOT ("status" = 'CANCELLED' AND "cancelReason" = 'out_of_stock')`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "BisOrder_reserved_deadline_idx" ON "BisOrder" ("reservedUntil") WHERE "status" = 'RESERVED'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "BisOrder_pending_age_idx" ON "BisOrder" ("createdAt") WHERE "status" = 'PENDING'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ShopOrder_shop_keyset_idx" ON "ShopOrder" ("shopId", "createdAt" DESC, "id" DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "OrderEvent_timeline_idx" ON "OrderEvent" ("bisOrderId", "createdAt", "id")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "StockReservation_release_due_idx" ON "StockReservation" ("nextReleaseAt") WHERE "status" = 'RELEASE_PENDING'`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "StockReservation_order_product_key" ON "StockReservation" ("bisOrderId", "productId")`,
];

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`SET lock_timeout = '3s'`);
    for (const sql of CREATE) await q(sql);
    await q(`DROP INDEX CONCURRENTLY IF EXISTS "BisOrder_user_history_idx"`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "BisOrder_user_history_idx" ON "BisOrder" ("userId", "createdAt" DESC) INCLUDE ("status", "total")`,
    );
    for (const name of [
      'StockReservation_order_product_key',
      'StockReservation_release_due_idx',
      'OrderEvent_timeline_idx',
      'ShopOrder_shop_keyset_idx',
      'BisOrder_pending_age_idx',
      'BisOrder_reserved_deadline_idx',
      'BisOrder_user_history_v2_idx',
    ])
      await q(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
  },
};
