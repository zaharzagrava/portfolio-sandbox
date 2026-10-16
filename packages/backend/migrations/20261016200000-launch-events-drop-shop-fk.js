'use strict';

/**
 * S22 G-37 (IX.4): `LaunchEvent.shopId` stays a plain UUID, the foreign key to "Shop" (another owner's table) goes.
 * Expand-only and idempotent; `lock_timeout` keeps a busy table from blocking the deploy.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '5s'`, {
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE "LaunchEvent" DROP CONSTRAINT IF EXISTS "LaunchEvent_shopId_fkey"`,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '5s'`, {
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE "LaunchEvent" ADD CONSTRAINT "LaunchEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") NOT VALID`,
        { transaction },
      );
    });
  },
};
