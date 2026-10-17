'use strict';

/**
 * S40 seller insights, expand step (III.11; specs/domains/S40-leaderboards-dashboard/data-model.md). Additive and
 * idempotent. Each group runs in its own short transaction with `SET LOCAL lock_timeout`:
 *
 *  - "SellerInsightsShop": the shop name/slug read model (R3), fed by `tenancy.shop_*`, version-guarded.
 *  - "SellerInsightsProduct": the product category read model (R3), fed by `catalog.product_*`, version-guarded.
 *  - "LeaderboardSnapshot": `shopName` (the name as of snapshot time) and `participants` (ranked shops of the board,
 *    backfilled from the stored rows, then NOT NULL). The primary key (period, board, rank) already makes
 *    (period kind, period id, category, rank) unique: a period id names its kind (`2026-W40` / `2026-10`) and board
 *    `all` is the overall board.
 *
 * No join to "Shop" or "Product": nothing in this domain reads another domain's table.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

const GROUPS = [
  [
    `CREATE TABLE IF NOT EXISTS "SellerInsightsShop" (
       "shopId" UUID PRIMARY KEY,
       "name" TEXT NOT NULL,
       "slug" TEXT NOT NULL,
       "shopVersion" INTEGER NOT NULL,
       "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS "SellerInsightsProduct" (
       "productId" UUID PRIMARY KEY,
       "shopId" UUID NOT NULL,
       "category" TEXT NULL,
       "productVersion" INTEGER NOT NULL,
       "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS "SellerInsightsProduct_shop_idx" ON "SellerInsightsProduct" ("shopId")`,
  ],
  [
    `ALTER TABLE "LeaderboardSnapshot"
       ADD COLUMN IF NOT EXISTS "shopName" TEXT NULL,
       ADD COLUMN IF NOT EXISTS "participants" INTEGER NULL`,
    `UPDATE "LeaderboardSnapshot" s SET "participants" = c.n
       FROM (SELECT "period", "board", COUNT(*)::int AS n FROM "LeaderboardSnapshot" GROUP BY "period", "board") c
       WHERE s."period" = c."period" AND s."board" = c."board" AND s."participants" IS NULL`,
    `ALTER TABLE "LeaderboardSnapshot" ALTER COLUMN "participants" SET NOT NULL`,
  ],
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const statements of GROUPS) {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(LOCK_TIMEOUT, { transaction });
        for (const sql of statements) await sequelize.query(sql, { transaction });
      });
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query(`ALTER TABLE "LeaderboardSnapshot" DROP COLUMN IF EXISTS "participants", DROP COLUMN IF EXISTS "shopName"`);
    await sequelize.query(`DROP TABLE IF EXISTS "SellerInsightsProduct"`);
    await sequelize.query(`DROP TABLE IF EXISTS "SellerInsightsShop"`);
  },
};
