'use strict';

/** SD-38 flags: definitions + audit trail. Services never query this table per evaluation (local SDK). */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "FeatureFlag" (
        "key" TEXT PRIMARY KEY CHECK ("key" ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
        "description" TEXT NOT NULL DEFAULT '',
        "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
        "variants" JSONB NOT NULL,
        "defaultVariant" TEXT NOT NULL,
        "offVariant" TEXT NOT NULL,
        "rules" JSONB NOT NULL DEFAULT '[]',
        "bucketBy" TEXT NOT NULL DEFAULT 'userId',
        "clientSide" BOOLEAN NOT NULL DEFAULT FALSE, -- exposed (pre-evaluated) to browsers/apps via GET /api/flags
        "owner" TEXT NOT NULL,
        "expiresAt" TIMESTAMPTZ NULL,
        "version" INTEGER NOT NULL DEFAULT 1,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS "FlagAudit" (
        "id" BIGSERIAL PRIMARY KEY,
        "flagKey" TEXT NOT NULL,
        "actorId" UUID NULL,
        "action" TEXT NOT NULL,
        "before" JSONB NULL,
        "after" JSONB NULL,
        "at" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "FlagAudit_flag_idx" ON "FlagAudit" ("flagKey", "at" DESC);
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "FlagAudit", "FeatureFlag"`);
  },
};
