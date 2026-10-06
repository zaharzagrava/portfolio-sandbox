'use strict';

/**
 * SD-30 webhook endpoints. Secrets are sealed (AES-256-GCM, SecretBox); during
 * rotation the previous secret stays valid until `previousSecretExpiresAt`.
 * Delivery attempts/bodies live in DynamoDB `WebhookAttempts` (TTL 30 days).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "WebhookEndpoint" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "url" TEXT NOT NULL,
        "events" TEXT[] NOT NULL,
        "apiVersion" TEXT NOT NULL,
        "secretSealed" TEXT NOT NULL,
        "previousSecretSealed" TEXT NULL,
        "previousSecretExpiresAt" TIMESTAMPTZ NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
        "disabledReason" TEXT NULL,
        "failingSince" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "WebhookEndpoint_shop_idx" ON "WebhookEndpoint" ("shopId") WHERE enabled;
      CREATE INDEX IF NOT EXISTS "WebhookEndpoint_failing_idx" ON "WebhookEndpoint" ("failingSince") WHERE enabled AND "failingSince" IS NOT NULL;
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "WebhookEndpoint"`);
  },
};
