'use strict';

/**
 * SD-02 tenancy - EXPAND phase (zero-downtime, lesson 03/03 §1):
 *  1. new tables (Shop, ShopMembership, ShopInvite, ShopDirectory, ShopSsoConfig)
 *  2. nullable "shopId" on existing shop-scoped tables + indexes CONCURRENTLY
 *  3. the backfill runs as a batched job (`tenancy.backfill-shops`), not here
 *  4. CONTRACT (NOT NULL) is a later migration, after the backfill finished
 * Old code keeps working throughout: it neither reads nor writes shopId.
 *
 * RLS is enabled (FORCE, so it applies to the table owner the app connects as)
 * on shop-PRIVATE tables only. Policies read `app.shop_id`, set per
 * transaction with set_config(..., true) - transaction-scoped, so it is safe
 * behind PgBouncer in transaction pooling mode (a session-level SET would leak
 * the tenant to the next client of that server connection).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '5s'`);
      await q(`
        CREATE TABLE IF NOT EXISTS "Shop" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "slug" TEXT NOT NULL UNIQUE,
          "name" TEXT NOT NULL,
          "plan" TEXT NOT NULL DEFAULT 'STARTER',
          "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','SUSPENDED','DELETING')),
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS "ShopMembership" (
          "shopId" UUID NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE,
          "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
          "role" TEXT NOT NULL CHECK ("role" IN ('OWNER','ADMIN','STAFF','VIEWER')),
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("shopId", "userId")
        );
        -- "Which shops am I in?" - a user can belong to many shops (agencies, consultants).
        CREATE INDEX IF NOT EXISTS "ShopMembership_user_idx" ON "ShopMembership" ("userId");

        CREATE TABLE IF NOT EXISTS "ShopInvite" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopId" UUID NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE,
          "email" TEXT NOT NULL,
          "role" TEXT NOT NULL CHECK ("role" IN ('ADMIN','STAFF','VIEWER')),
          "tokenHash" TEXT NOT NULL UNIQUE,
          "invitedBy" UUID NOT NULL,
          "expiresAt" TIMESTAMPTZ NOT NULL,
          "acceptedAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "ShopInvite_shop_idx" ON "ShopInvite" ("shopId", "createdAt" DESC);

        -- Tenant → cell routing (pooled vs dedicated database) for the hybrid isolation model.
        CREATE TABLE IF NOT EXISTS "ShopDirectory" (
          "shopId" UUID PRIMARY KEY REFERENCES "Shop"("id") ON DELETE CASCADE,
          "cell" TEXT NOT NULL DEFAULT 'pooled',
          "region" TEXT NOT NULL DEFAULT 'eu-central-1',
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS "ShopSsoConfig" (
          "shopId" UUID PRIMARY KEY REFERENCES "Shop"("id") ON DELETE CASCADE,
          "issuer" TEXT NOT NULL,
          "clientId" TEXT NOT NULL,
          "clientSecretEnc" TEXT NOT NULL,
          "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "shopId" UUID NULL REFERENCES "Shop"("id");
        ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "shopId" UUID NULL REFERENCES "Shop"("id");

        ALTER TABLE "ShopInvite" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "ShopInvite" FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON "ShopInvite";
        CREATE POLICY tenant_isolation ON "ShopInvite"
          USING ("shopId" = nullif(current_setting('app.shop_id', true), '')::uuid
                 OR current_setting('app.rls_bypass', true) = 'on');

        ALTER TABLE "ShopSsoConfig" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "ShopSsoConfig" FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON "ShopSsoConfig";
        CREATE POLICY tenant_isolation ON "ShopSsoConfig"
          USING ("shopId" = nullif(current_setting('app.shop_id', true), '')::uuid
                 OR current_setting('app.rls_bypass', true) = 'on');
      `);
    });

    // Leading with shopId: every tenant query filters by it first (lesson 03/01 §3.1).
    await queryInterface.sequelize.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "Product_shop_created_idx" ON "Product" ("shopId", "createdAt" DESC)`);
    await queryInterface.sequelize.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatChannel_shop_idx" ON "ChatChannel" ("shopId")`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "ChatChannel_shop_idx";
      DROP INDEX IF EXISTS "Product_shop_created_idx";
      ALTER TABLE "ChatChannel" DROP COLUMN IF EXISTS "shopId";
      ALTER TABLE "Product" DROP COLUMN IF EXISTS "shopId";
      DROP TABLE IF EXISTS "ShopSsoConfig", "ShopDirectory", "ShopInvite", "ShopMembership", "Shop";
    `);
  },
};
