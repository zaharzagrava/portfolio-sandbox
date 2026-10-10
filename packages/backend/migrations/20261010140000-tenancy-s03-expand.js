'use strict';

/**
 * S03 tenancy (expand-only, III.11; reversible):
 *  - "Shop": planVersion, shopVersion, purgeAt; status check gains DELETED.
 *  - "ShopMembership": source (existing rows become 'provisioned'); indexes for "my shops" and the members page;
 *    row-level security (shop context, bypass, or - for reads - the owning user).
 *  - "ShopInvite": revokedAt, acceptedBy; the partial unique index of one pending invite per (shop, lower(email));
 *    older duplicates are revoked first (never deleted); an index on expiresAt for the purge job.
 *  - "ShopDirectory": version (conditional move). "ShopSsoConfig": defaultRole.
 *  - "ShopStatusHistory": append-only record of every status change.
 * Large indexes are created CONCURRENTLY after the transaction. The foreign key from "ShopMembership" to "User" is
 * dropped by the separate contract migration.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "planVersion" BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "shopVersion" BIGINT NOT NULL DEFAULT 1;
        ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "purgeAt" TIMESTAMPTZ NULL;
        ALTER TABLE "Shop" DROP CONSTRAINT IF EXISTS "Shop_status_check";
        ALTER TABLE "Shop" ADD CONSTRAINT "Shop_status_check"
          CHECK ("status" IN ('ACTIVE','SUSPENDED','DELETING','DELETED'));

        ALTER TABLE "ShopMembership" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'provisioned';
        ALTER TABLE "ShopMembership" DROP CONSTRAINT IF EXISTS "ShopMembership_source_check";
        ALTER TABLE "ShopMembership" ADD CONSTRAINT "ShopMembership_source_check"
          CHECK ("source" IN ('owner','invite','sso','provisioned'));

        ALTER TABLE "ShopInvite" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMPTZ NULL;
        ALTER TABLE "ShopInvite" ADD COLUMN IF NOT EXISTS "acceptedBy" UUID NULL;

        ALTER TABLE "ShopDirectory" ADD COLUMN IF NOT EXISTS "version" BIGINT NOT NULL DEFAULT 1;

        ALTER TABLE "ShopSsoConfig" ADD COLUMN IF NOT EXISTS "defaultRole" TEXT NOT NULL DEFAULT 'VIEWER';
        ALTER TABLE "ShopSsoConfig" DROP CONSTRAINT IF EXISTS "ShopSsoConfig_defaultRole_check";
        ALTER TABLE "ShopSsoConfig" ADD CONSTRAINT "ShopSsoConfig_defaultRole_check"
          CHECK ("defaultRole" IN ('STAFF','VIEWER'));

        CREATE TABLE IF NOT EXISTS "ShopStatusHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopId" UUID NOT NULL,
          "from" TEXT NULL,
          "to" TEXT NOT NULL,
          "actor" TEXT NOT NULL,
          "reason" TEXT NULL,
          "at" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "ShopStatusHistory_shop_at_idx" ON "ShopStatusHistory" ("shopId", "at" DESC);

        -- Older duplicates of a pending (shop, address) pair are revoked, never deleted; the newest stays.
        UPDATE "ShopInvite" i SET "revokedAt" = now()
        WHERE i."acceptedAt" IS NULL AND i."revokedAt" IS NULL AND EXISTS (
          SELECT 1 FROM "ShopInvite" n
          WHERE n."shopId" = i."shopId" AND lower(n."email") = lower(i."email")
            AND n."acceptedAt" IS NULL AND n."revokedAt" IS NULL
            AND (n."createdAt", n."id") > (i."createdAt", i."id"));

        -- Membership is visible by shop, or by the owning user for reads ("which shops am I in?").
        ALTER TABLE "ShopMembership" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "ShopMembership" FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON "ShopMembership";
        CREATE POLICY tenant_isolation ON "ShopMembership"
          USING ("shopId" = nullif(current_setting('app.shop_id', true), '')::uuid
                 OR current_setting('app.rls_bypass', true) = 'on')
          WITH CHECK ("shopId" = nullif(current_setting('app.shop_id', true), '')::uuid
                 OR current_setting('app.rls_bypass', true) = 'on');
        DROP POLICY IF EXISTS own_memberships ON "ShopMembership";
        CREATE POLICY own_memberships ON "ShopMembership" FOR SELECT
          USING ("userId" = nullif(current_setting('app.user_id', true), '')::uuid);

        -- WITH CHECK on the policies that only had USING: an insert or update into another shop is refused too.
        DROP POLICY IF EXISTS tenant_isolation ON "ShopInvite";
        CREATE POLICY tenant_isolation ON "ShopInvite"
          USING ("shopId" = nullif(current_setting('app.shop_id', true), '')::uuid
                 OR current_setting('app.rls_bypass', true) = 'on')
          WITH CHECK ("shopId" = nullif(current_setting('app.shop_id', true), '')::uuid
                 OR current_setting('app.rls_bypass', true) = 'on');
        DROP POLICY IF EXISTS tenant_isolation ON "ShopSsoConfig";
        CREATE POLICY tenant_isolation ON "ShopSsoConfig"
          USING ("shopId" = nullif(current_setting('app.shop_id', true), '')::uuid
                 OR current_setting('app.rls_bypass', true) = 'on')
          WITH CHECK ("shopId" = nullif(current_setting('app.shop_id', true), '')::uuid
                 OR current_setting('app.rls_bypass', true) = 'on');
      `);
    });

    // CONCURRENTLY can't run inside a transaction block.
    const c = (sql) => queryInterface.sequelize.query(sql);
    await c(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ShopInvite_pending_email_uq" ON "ShopInvite" ("shopId", lower("email")) WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL`);
    await c(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "ShopMembership_user_created_idx" ON "ShopMembership" ("userId", "createdAt", "shopId")`);
    await c(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "ShopMembership_shop_created_idx" ON "ShopMembership" ("shopId", "createdAt", "userId")`);
    await c(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "Shop_deleting_purge_idx" ON "Shop" ("status", "purgeAt") WHERE "status" = 'DELETING'`);
    await c(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "ShopInvite_expires_idx" ON "ShopInvite" ("expiresAt")`);
    // Exists since the developer-platform migration; kept here so a fresh database has it whatever the order.
    await c(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Shop_sandbox_of_uq" ON "Shop" ("sandboxOf") WHERE "sandboxOf" IS NOT NULL`);
  },

  async down(queryInterface) {
    const c = (sql) => queryInterface.sequelize.query(sql);
    await c(`DROP INDEX CONCURRENTLY IF EXISTS "ShopInvite_expires_idx"`);
    await c(`DROP INDEX CONCURRENTLY IF EXISTS "Shop_deleting_purge_idx"`);
    await c(`DROP INDEX CONCURRENTLY IF EXISTS "ShopMembership_shop_created_idx"`);
    await c(`DROP INDEX CONCURRENTLY IF EXISTS "ShopMembership_user_created_idx"`);
    await c(`DROP INDEX CONCURRENTLY IF EXISTS "ShopInvite_pending_email_uq"`);
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        DROP POLICY IF EXISTS own_memberships ON "ShopMembership";
        DROP POLICY IF EXISTS tenant_isolation ON "ShopMembership";
        ALTER TABLE "ShopMembership" NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE "ShopMembership" DISABLE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS tenant_isolation ON "ShopInvite";
        CREATE POLICY tenant_isolation ON "ShopInvite"
          USING ("shopId" = nullif(current_setting('app.shop_id', true), '')::uuid
                 OR current_setting('app.rls_bypass', true) = 'on');
        DROP POLICY IF EXISTS tenant_isolation ON "ShopSsoConfig";
        CREATE POLICY tenant_isolation ON "ShopSsoConfig"
          USING ("shopId" = nullif(current_setting('app.shop_id', true), '')::uuid
                 OR current_setting('app.rls_bypass', true) = 'on');

        DROP TABLE IF EXISTS "ShopStatusHistory";
        ALTER TABLE "ShopSsoConfig" DROP CONSTRAINT IF EXISTS "ShopSsoConfig_defaultRole_check";
        ALTER TABLE "ShopSsoConfig" DROP COLUMN IF EXISTS "defaultRole";
        ALTER TABLE "ShopDirectory" DROP COLUMN IF EXISTS "version";
        ALTER TABLE "ShopInvite" DROP COLUMN IF EXISTS "acceptedBy";
        ALTER TABLE "ShopInvite" DROP COLUMN IF EXISTS "revokedAt";
        ALTER TABLE "ShopMembership" DROP CONSTRAINT IF EXISTS "ShopMembership_source_check";
        ALTER TABLE "ShopMembership" DROP COLUMN IF EXISTS "source";
        UPDATE "Shop" SET "status" = 'DELETING' WHERE "status" = 'DELETED';
        ALTER TABLE "Shop" DROP CONSTRAINT IF EXISTS "Shop_status_check";
        ALTER TABLE "Shop" ADD CONSTRAINT "Shop_status_check" CHECK ("status" IN ('ACTIVE','SUSPENDED','DELETING'));
        ALTER TABLE "Shop" DROP COLUMN IF EXISTS "purgeAt";
        ALTER TABLE "Shop" DROP COLUMN IF EXISTS "shopVersion";
        ALTER TABLE "Shop" DROP COLUMN IF EXISTS "planVersion";
      `);
    });
  },
};
