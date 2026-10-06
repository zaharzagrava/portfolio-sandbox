'use strict';

/**
 * SD-01 embeddable widget. A site = publishable key (public, in the shop's
 * HTML) + the exact origins allowed to use it + a sealed identity secret the
 * shop's BACKEND uses to sign customer hand-off tokens.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "WidgetSite" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "publishableKey" TEXT NOT NULL UNIQUE,
        "allowedOrigins" TEXT[] NOT NULL,
        "identitySecretSealed" TEXT NOT NULL,
        "featuredProductIds" UUID[] NOT NULL DEFAULT '{}',
        "theme" JSONB NOT NULL DEFAULT '{}',
        "killSwitch" BOOLEAN NOT NULL DEFAULT FALSE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "WidgetSite_shop_idx" ON "WidgetSite" ("shopId");
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "WidgetSite"`);
  },
};
