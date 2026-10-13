'use strict';

/**
 * S36, own step (IX.4, L7): `AdCampaign.shopId` and `productId` become plain UUID columns. The foreign keys pointed at
 * tables owned by tenancy and catalog; every lookup of marketing carries the shop in its predicate instead, and the
 * product and shop facts come from the read models and the R1 batch lookups. The internal key
 * `AdBillingRun → AdCampaign` stays. No column is touched, so running code is unaffected.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`SET LOCAL lock_timeout = '3s'`, { transaction });
      await sequelize.query(
        `ALTER TABLE "AdCampaign"
           DROP CONSTRAINT IF EXISTS "AdCampaign_shopId_fkey",
           DROP CONSTRAINT IF EXISTS "AdCampaign_productId_fkey"`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`SET LOCAL lock_timeout = '3s'`, { transaction });
      // NOT VALID: rows written while the keys were gone are not re-checked, new writes are.
      await sequelize.query(
        `ALTER TABLE "AdCampaign"
           ADD CONSTRAINT "AdCampaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") NOT VALID,
           ADD CONSTRAINT "AdCampaign_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") NOT VALID`,
        { transaction },
      );
    });
  },
};
