'use strict';

/** SD-40 seller functions: versions go through a judge (test cases) before they can run at checkout. */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "ShopFunction" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "name" TEXT NOT NULL,
        "activeVersion" INTEGER NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE ("shopId", "name")
      );
      CREATE TABLE IF NOT EXISTS "ShopFunctionVersion" (
        "functionId" UUID NOT NULL REFERENCES "ShopFunction"("id") ON DELETE CASCADE,
        "version" INTEGER NOT NULL,
        "source" TEXT NOT NULL CHECK (length("source") <= 20000),
        "sourceHash" CHAR(64) NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED', 'TESTING', 'ACTIVE', 'REJECTED', 'SUPERSEDED')),
        "verdicts" JSONB NULL,
        "createdBy" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("functionId", "version")
      );
      CREATE TABLE IF NOT EXISTS "ShopFunctionTestCase" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "functionId" UUID NOT NULL REFERENCES "ShopFunction"("id") ON DELETE CASCADE,
        "name" TEXT NOT NULL,
        "input" JSONB NOT NULL,
        "expected" JSONB NOT NULL
      );
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "ShopFunctionTestCase", "ShopFunctionVersion", "ShopFunction"`);
  },
};
