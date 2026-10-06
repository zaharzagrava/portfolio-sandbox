'use strict';

/**
 * SD-36 shop integrations (Shopify / WooCommerce). ExternalLink maps provider
 * ids to ours and keeps the hashes used for echo suppression; malformed
 * provider payloads land in SyncQuarantine instead of crashing the sync.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "Integration" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "provider" TEXT NOT NULL CHECK ("provider" IN ('shopify', 'woocommerce', 'fake')),
        "externalShop" TEXT NOT NULL,
        "credentialsSealed" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'PAUSED', 'ERROR')),
        "lastError" TEXT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE ("shopId", "provider", "externalShop")
      );
      CREATE TABLE IF NOT EXISTS "SyncCursor" (
        "integrationId" UUID NOT NULL REFERENCES "Integration"("id") ON DELETE CASCADE,
        "entity" TEXT NOT NULL,
        "watermark" TIMESTAMPTZ NULL,
        "pageCursor" TEXT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("integrationId", "entity")
      );
      CREATE TABLE IF NOT EXISTS "ExternalLink" (
        "integrationId" UUID NOT NULL REFERENCES "Integration"("id") ON DELETE CASCADE,
        "entity" TEXT NOT NULL,
        "externalId" TEXT NOT NULL,
        "localId" UUID NOT NULL,
        "lastHash" TEXT NOT NULL,
        "lastPushedHash" TEXT NULL,
        "raw" JSONB NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("integrationId", "entity", "externalId")
      );
      CREATE INDEX IF NOT EXISTS "ExternalLink_local_idx" ON "ExternalLink" ("localId");
      CREATE TABLE IF NOT EXISTS "SyncQuarantine" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "integrationId" UUID NOT NULL REFERENCES "Integration"("id") ON DELETE CASCADE,
        "entity" TEXT NOT NULL,
        "externalId" TEXT NULL,
        "reason" TEXT NOT NULL,
        "payload" JSONB NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "SyncQuarantine", "ExternalLink", "SyncCursor", "Integration"`);
  },
};
