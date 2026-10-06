'use strict';

/**
 * SD-07 public API. Keys store only a hash (the secret is shown once). Test
 * keys act on a lazily created SANDBOX shadow shop (`Shop.sandboxOf`), so every
 * existing tenant boundary (WHERE shopId, RLS) isolates sandbox data for free.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "sandboxOf" UUID NULL REFERENCES "Shop"("id");
      CREATE UNIQUE INDEX IF NOT EXISTS "Shop_sandbox_of_uq" ON "Shop" ("sandboxOf") WHERE "sandboxOf" IS NOT NULL;

      CREATE TABLE IF NOT EXISTS "ApiKey" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "prefix" TEXT NOT NULL UNIQUE,
        "hash" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "scopes" TEXT[] NOT NULL,
        "livemode" BOOLEAN NOT NULL,
        "createdBy" UUID NOT NULL REFERENCES "User"("id"),
        "expiresAt" TIMESTAMPTZ NULL,
        "revokedAt" TIMESTAMPTZ NULL,
        "lastUsedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "ApiKey_shop_idx" ON "ApiKey" ("shopId");

      CREATE TABLE IF NOT EXISTS "ShopApiSettings" (
        "shopId" UUID PRIMARY KEY REFERENCES "Shop"("id"),
        "pinnedVersion" TEXT NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS "ShopApiSettings", "ApiKey";
      DROP INDEX IF EXISTS "Shop_sandbox_of_uq";
      ALTER TABLE "Shop" DROP COLUMN IF EXISTS "sandboxOf";
    `);
  },
};
