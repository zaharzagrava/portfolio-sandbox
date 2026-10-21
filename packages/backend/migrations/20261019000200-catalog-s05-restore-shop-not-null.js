'use strict';

/**
 * S05 catalog: puts "Product"."shopId" NOT NULL back. On PostgreSQL 18 the contract step
 * 20261012110100 dropped the constraint it had just set (the NOT NULL carries the same default name as the old S03
 * CHECK it meant to remove). Idempotent: does nothing where the column is already NOT NULL. Refuses to run while
 * products without a shop remain.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const [[col]] = await sequelize.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Product' AND column_name = 'shopId'`,
    );
    if (!col || col.is_nullable === 'NO') return;
    const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM "Product" WHERE "shopId" IS NULL`);
    if (n > 0)
      throw new Error(
        `${n} products still have no shopId: let the job products.backfill-shop-ids finish, then deploy this step`,
      );
    const step = (sql) =>
      sequelize.transaction(async (transaction) => {
        await sequelize.query(`SET LOCAL lock_timeout = '3s'`, { transaction });
        await sequelize.query(sql, { transaction });
      });
    await step(`ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_shopId_not_null_tmp"`);
    await step(`ALTER TABLE "Product" ADD CONSTRAINT "Product_shopId_not_null_tmp" CHECK ("shopId" IS NOT NULL) NOT VALID`);
    await sequelize.query(`ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_shopId_not_null_tmp"`);
    await step(`ALTER TABLE "Product" ALTER COLUMN "shopId" SET NOT NULL`);
    await step(`ALTER TABLE "Product" DROP CONSTRAINT "Product_shopId_not_null_tmp"`);
  },

  async down() {
    // Nothing to undo: the previous state was the mistake.
  },
};
