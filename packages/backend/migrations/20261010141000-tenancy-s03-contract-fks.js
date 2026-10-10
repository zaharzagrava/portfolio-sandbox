'use strict';

/**
 * S03 tenancy, contract step (III.11, IX.4): "ShopMembership"."userId" no longer references identity's "User".
 * Cross-domain references are plain ids. Product.shopId and ChatChannel.shopId keep their foreign keys to "Shop":
 * their owners (catalog, chat) drop them in their own migrations (gaps.md follow-ups).
 * Deploy after the code that stopped relying on the cascade is running.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '3s'`, {
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE "ShopMembership" DROP CONSTRAINT IF EXISTS "ShopMembership_userId_fkey"`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      // Memberships of users that no longer exist cannot satisfy the constraint again.
      await q(`DELETE FROM "ShopMembership" m WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = m."userId")`);
      await q(
        `ALTER TABLE "ShopMembership" ADD CONSTRAINT "ShopMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE`,
      );
    });
  },
};
