'use strict';

/** S32 discovery, expand step 2: "SearchShopState", the copy of tenancy shop status/plan fed by shop.events (IX.8). */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await t(`SET LOCAL lock_timeout = '3s'`);
      await t(`
        CREATE TABLE IF NOT EXISTS "SearchShopState" (
          "shopId" UUID PRIMARY KEY,
          "status" TEXT NOT NULL CHECK ("status" IN ('ACTIVE','SUSPENDED','DELETING','DELETED')),
          "plan" TEXT NULL CHECK ("plan" IS NULL OR "plan" IN ('STARTER','PRO','ENTERPRISE')),
          "shopVersion" BIGINT NULL,
          "offboarding" BOOLEAN NOT NULL DEFAULT false,
          "lastEventAt" TIMESTAMPTZ NOT NULL
        );
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP TABLE IF EXISTS "SearchShopState"`,
    );
  },
};
