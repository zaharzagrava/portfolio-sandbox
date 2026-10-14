'use strict';

/**
 * S44 expand (specs/domains/S44-storefront-widget/data-model.md, step 1). Additive only: nothing the running code reads
 * changes shape. Every statement runs under `lock_timeout = '3s'`; each one is idempotent.
 *
 *  - `WidgetSite`: `name`, `version`, `previousIdentitySecretSealed`, `previousSecretExpiresAt`, the shop copy
 *    (`shopName`, `shopStatus`, `shopVersion`) and `updatedAt`
 *  - CHECKs added `NOT VALID` and then validated: 1..10 origins, at most 12 featured products, key format, a previous
 *    secret and its expiry are both set or both null
 *  - index `(shopId, createdAt DESC, id)` for the keyset list
 *  - `WidgetSiteChange`: append-only history (foreign key only to its own site); `seq` is the commit-ordered position
 *    that keyset paging and the unbroken-chain check use (rows of one site are written under the site's row lock)
 *
 * The shop copy of existing rows is filled by `infra/widget-shop-copy.backfill.ts`, the foreign key to `Shop` is dropped
 * by the contract migration that follows. `down` is meant for a throwaway database only.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        ALTER TABLE "WidgetSite" ADD COLUMN IF NOT EXISTS "name" VARCHAR(60) NOT NULL DEFAULT 'Storefront widget';
        ALTER TABLE "WidgetSite" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE "WidgetSite" ADD COLUMN IF NOT EXISTS "previousIdentitySecretSealed" TEXT NULL;
        ALTER TABLE "WidgetSite" ADD COLUMN IF NOT EXISTS "previousSecretExpiresAt" TIMESTAMPTZ NULL;
        ALTER TABLE "WidgetSite" ADD COLUMN IF NOT EXISTS "shopName" TEXT NOT NULL DEFAULT '';
        ALTER TABLE "WidgetSite" ADD COLUMN IF NOT EXISTS "shopStatus" TEXT NOT NULL DEFAULT 'ACTIVE';
        ALTER TABLE "WidgetSite" ADD COLUMN IF NOT EXISTS "shopVersion" BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE "WidgetSite" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();

        CREATE INDEX IF NOT EXISTS "WidgetSite_shop_list_idx" ON "WidgetSite" ("shopId", "createdAt" DESC, "id");
      `);
      const checks = [
        [
          'WidgetSite_origins_chk',
          `cardinality("allowedOrigins") BETWEEN 1 AND 10`,
        ],
        [
          'WidgetSite_featured_chk',
          `cardinality("featuredProductIds") <= 12`,
        ],
        [
          'WidgetSite_key_chk',
          `"publishableKey" ~ '^pk_live_[A-Za-z0-9_-]{24}$'`,
        ],
        [
          'WidgetSite_previous_chk',
          `("previousIdentitySecretSealed" IS NULL) = ("previousSecretExpiresAt" IS NULL)`,
        ],
      ];
      for (const [name, expression] of checks) {
        await q(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
              ALTER TABLE "WidgetSite" ADD CONSTRAINT "${name}" CHECK (${expression}) NOT VALID;
            END IF;
          END $$;
        `);
      }
      await q(`
        CREATE TABLE IF NOT EXISTS "WidgetSiteChange" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "seq" BIGINT GENERATED ALWAYS AS IDENTITY,
          "siteId" UUID NOT NULL REFERENCES "WidgetSite"("id") ON DELETE CASCADE,
          "shopId" UUID NOT NULL,
          "change" TEXT NOT NULL,
          "fromValue" TEXT NULL,
          "toValue" TEXT NULL,
          "actorId" UUID NULL,
          "at" TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "WidgetSiteChange_site_idx" ON "WidgetSiteChange" ("siteId", "seq" DESC);
        CREATE INDEX IF NOT EXISTS "WidgetSiteChange_shop_idx" ON "WidgetSiteChange" ("shopId");
      `);
    });

    // VALIDATE takes a weaker lock and scans the table; legacy rows that break a CHECK fail loudly here.
    for (const name of [
      'WidgetSite_origins_chk',
      'WidgetSite_featured_chk',
      'WidgetSite_key_chk',
      'WidgetSite_previous_chk',
    ])
      await queryInterface.sequelize.query(
        `ALTER TABLE "WidgetSite" VALIDATE CONSTRAINT "${name}"`,
      );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS "WidgetSiteChange";
      DROP INDEX IF EXISTS "WidgetSite_shop_list_idx";
      ALTER TABLE "WidgetSite" DROP CONSTRAINT IF EXISTS "WidgetSite_previous_chk";
      ALTER TABLE "WidgetSite" DROP CONSTRAINT IF EXISTS "WidgetSite_key_chk";
      ALTER TABLE "WidgetSite" DROP CONSTRAINT IF EXISTS "WidgetSite_featured_chk";
      ALTER TABLE "WidgetSite" DROP CONSTRAINT IF EXISTS "WidgetSite_origins_chk";
      ALTER TABLE "WidgetSite" DROP COLUMN IF EXISTS "updatedAt";
      ALTER TABLE "WidgetSite" DROP COLUMN IF EXISTS "shopVersion";
      ALTER TABLE "WidgetSite" DROP COLUMN IF EXISTS "shopStatus";
      ALTER TABLE "WidgetSite" DROP COLUMN IF EXISTS "shopName";
      ALTER TABLE "WidgetSite" DROP COLUMN IF EXISTS "previousSecretExpiresAt";
      ALTER TABLE "WidgetSite" DROP COLUMN IF EXISTS "previousIdentitySecretSealed";
      ALTER TABLE "WidgetSite" DROP COLUMN IF EXISTS "version";
      ALTER TABLE "WidgetSite" DROP COLUMN IF EXISTS "name";
    `);
  },
};
