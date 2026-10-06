'use strict';

/** SD-15: stream metadata only - comments live in DynamoDB, reactions/viewers in Redis. */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "LiveStream" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "title" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK ("status" IN ('SCHEDULED', 'LIVE', 'ENDED')),
        "launchEventId" UUID NULL,
        "startedAt" TIMESTAMPTZ NULL,
        "endedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "LiveStream_shop_idx" ON "LiveStream" ("shopId", "createdAt" DESC);
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "LiveStream"`);
  },
};
