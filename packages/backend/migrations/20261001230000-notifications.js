'use strict';

/**
 * SD-17 relational side: what users WANT (preferences, quiet hours, devices)
 * and who must never be contacted again (suppressions). The high-volume parts
 * - inbox and delivery log - live in Scylla (cql/030_notifications.cql).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        CREATE TABLE IF NOT EXISTS "NotificationSettings" (
          "userId" UUID PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
          "timezone" TEXT NOT NULL DEFAULT 'UTC',
          "locale" TEXT NOT NULL DEFAULT 'en',
          "quietStart" TEXT NULL CHECK ("quietStart" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
          "quietEnd" TEXT NULL CHECK ("quietEnd" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
          "phone" TEXT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        -- Sparse: only overrides of the per-category defaults are stored.
        CREATE TABLE IF NOT EXISTS "NotificationPreference" (
          "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
          "category" TEXT NOT NULL,
          "channel" TEXT NOT NULL CHECK ("channel" IN ('email', 'sms', 'push', 'inapp')),
          "enabled" BOOLEAN NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("userId", "category", "channel")
        );

        CREATE TABLE IF NOT EXISTS "PushDevice" (
          "token" TEXT PRIMARY KEY,
          "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
          "platform" TEXT NOT NULL CHECK ("platform" IN ('ios', 'android', 'web')),
          "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "PushDevice_user_idx" ON "PushDevice" ("userId");

        -- Hard bounces, spam complaints, carrier opt-outs, dead push tokens. Checked before every send.
        CREATE TABLE IF NOT EXISTS "NotificationSuppression" (
          "channel" TEXT NOT NULL,
          "address" TEXT NOT NULL,
          "reason" TEXT NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("channel", "address")
        );
        `,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "NotificationSuppression", "PushDevice", "NotificationPreference", "NotificationSettings"`);
  },
};
