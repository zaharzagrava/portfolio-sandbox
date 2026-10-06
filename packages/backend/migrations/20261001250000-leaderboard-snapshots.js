'use strict';

/** SD-18: finished periods are frozen here (Redis boards expire; history and "badges" don't). */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "LeaderboardSnapshot" (
        "period" TEXT NOT NULL,
        "board" TEXT NOT NULL,
        "rank" INTEGER NOT NULL,
        "shopId" UUID NOT NULL,
        "revenue" BIGINT NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("period", "board", "rank")
      );
      CREATE INDEX IF NOT EXISTS "LeaderboardSnapshot_shop_idx" ON "LeaderboardSnapshot" ("shopId", "period");
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "LeaderboardSnapshot"`);
  },
};
