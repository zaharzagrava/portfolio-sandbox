'use strict';

/**
 * S31 asset library, expand step (III.11; specs/domains/S31-assets-digital-delivery/data-model.md). Additive and
 * idempotent: the old `deleted` flag, the foreign keys and the old share-link key stay until the contract step
 * (`20261010110000-asset-library-contract.js`). Every group runs in its own short transaction with `SET LOCAL
 * lock_timeout`. Times default to `now()` only for backfilled rows; the application always writes the platform clock.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

const GROUPS = [
  // Asset: status machine, deletedAt, createdAt; the unique path now covers ACTIVE rows only
  [
    `ALTER TABLE "Asset"
       ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE',
       ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_status_check"`,
    `ALTER TABLE "Asset" ADD CONSTRAINT "Asset_status_check" CHECK ("status" IN ('ACTIVE', 'DELETED', 'PURGED'))`,
    `UPDATE "Asset" SET "status" = 'DELETED', "deletedAt" = "updatedAt" WHERE "deleted" AND "status" = 'ACTIVE'`,
    `DROP INDEX IF EXISTS "Asset_shop_path_uq"`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Asset_shop_path_active_uq" ON "Asset" ("shopId", "path") WHERE "status" = 'ACTIVE'`,
    `CREATE INDEX IF NOT EXISTS "Asset_shop_list_idx" ON "Asset" ("shopId", "path", "id") WHERE "status" = 'ACTIVE'`,
    `CREATE INDEX IF NOT EXISTS "Asset_deleted_idx" ON "Asset" ("status", "deletedAt") WHERE "status" = 'DELETED'`,
  ],
  // AssetVersion: sizeBytes, history index
  [
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'AssetVersion' AND column_name = 'size') THEN
         ALTER TABLE "AssetVersion" RENAME COLUMN "size" TO "sizeBytes";
       END IF;
     END $$`,
    `CREATE INDEX IF NOT EXISTS "AssetVersion_history_idx" ON "AssetVersion" ("assetId", "version" DESC)`,
  ],
  // AssetChunk: confirmation in storage, protection from cleanup, claim flag, reservation flag
  [
    `ALTER TABLE "AssetChunk"
       ADD COLUMN IF NOT EXISTS "storedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "protectedUntil" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "deleting" BOOLEAN NOT NULL DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS "reserved" BOOLEAN NOT NULL DEFAULT FALSE`,
    // chunks that were committed were verified at commit time
    `UPDATE "AssetChunk" SET "storedAt" = now() WHERE "refCount" > 0 AND "storedAt" IS NULL`,
    `CREATE INDEX IF NOT EXISTS "AssetChunk_cleanup_idx" ON "AssetChunk" ("protectedUntil") WHERE "refCount" = 0`,
  ],
  // journal: retention floor and age index
  [
    `ALTER TABLE "AssetSyncState" ADD COLUMN IF NOT EXISTS "minSeq" BIGINT NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS "AssetChange_at_idx" ON "AssetChange" ("at")`,
  ],
  // share links: own id, shop, creator, revocation
  [
    `ALTER TABLE "AssetShareLink"
       ADD COLUMN IF NOT EXISTS "id" UUID NOT NULL DEFAULT uuidv7(),
       ADD COLUMN IF NOT EXISTS "shopId" UUID NULL,
       ADD COLUMN IF NOT EXISTS "createdBy" UUID NULL,
       ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
       ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMPTZ NULL`,
    `UPDATE "AssetShareLink" l SET "shopId" = a."shopId" FROM "Asset" a WHERE a."id" = l."assetId" AND l."shopId" IS NULL`,
    `ALTER TABLE "AssetShareLink" ALTER COLUMN "shopId" SET NOT NULL`,
    `ALTER TABLE "AssetShareLink" DROP CONSTRAINT IF EXISTS "AssetShareLink_pkey"`,
    `ALTER TABLE "AssetShareLink" ADD PRIMARY KEY ("id")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "AssetShareLink_token_uq" ON "AssetShareLink" ("tokenHash")`,
    `CREATE INDEX IF NOT EXISTS "AssetShareLink_asset_idx" ON "AssetShareLink" ("assetId")`,
  ],
  // digital products: shop and link time
  [
    `ALTER TABLE "DigitalProduct"
       ADD COLUMN IF NOT EXISTS "shopId" UUID NULL,
       ADD COLUMN IF NOT EXISTS "linkedAt" TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `UPDATE "DigitalProduct" d SET "shopId" = a."shopId" FROM "Asset" a WHERE a."id" = d."assetId" AND d."shopId" IS NULL`,
    `ALTER TABLE "DigitalProduct" ALTER COLUMN "shopId" SET NOT NULL`,
    `CREATE INDEX IF NOT EXISTS "DigitalProduct_asset_idx" ON "DigitalProduct" ("assetId")`,
  ],
  // new: chunk references per version (who references a chunk)
  [
    `CREATE TABLE IF NOT EXISTS "AssetVersionChunk" (
       "assetId" UUID NOT NULL,
       "version" INTEGER NOT NULL,
       "hash" CHAR(64) NOT NULL,
       "shopId" UUID NOT NULL,
       "occurrences" INTEGER NOT NULL CHECK ("occurrences" >= 1),
       PRIMARY KEY ("assetId", "version", "hash")
     )`,
    `CREATE INDEX IF NOT EXISTS "AssetVersionChunk_shop_hash_idx" ON "AssetVersionChunk" ("shopId", "hash")`,
    `INSERT INTO "AssetVersionChunk" ("assetId", "version", "hash", "shopId", "occurrences")
       SELECT v."assetId", v."version", h."hash", a."shopId", count(*)
         FROM "AssetVersion" v
         JOIN "Asset" a ON a."id" = v."assetId"
         CROSS JOIN LATERAL unnest(v."chunks") AS h("hash")
        GROUP BY v."assetId", v."version", h."hash", a."shopId"
       ON CONFLICT DO NOTHING`,
  ],
  // new: quota accounting
  [
    `CREATE TABLE IF NOT EXISTS "AssetShopUsage" (
       "shopId" UUID PRIMARY KEY,
       "storedBytes" BIGINT NOT NULL DEFAULT 0,
       "reservedBytes" BIGINT NOT NULL DEFAULT 0,
       CONSTRAINT "AssetShopUsage_nonneg" CHECK ("storedBytes" >= 0 AND "reservedBytes" >= 0)
     )`,
    `INSERT INTO "AssetShopUsage" ("shopId", "storedBytes", "reservedBytes")
       SELECT "shopId", COALESCE(SUM("size") FILTER (WHERE "storedAt" IS NOT NULL), 0), 0
         FROM "AssetChunk" GROUP BY "shopId"
       ON CONFLICT DO NOTHING`,
  ],
  // new: entitlements, grants, order revocations
  [
    `CREATE TABLE IF NOT EXISTS "AssetEntitlement" (
       "id" UUID PRIMARY KEY DEFAULT uuidv7(),
       "orderId" UUID NOT NULL,
       "productId" UUID NOT NULL,
       "shopId" UUID NOT NULL,
       "buyerId" TEXT NOT NULL,
       "assetId" UUID NOT NULL,
       "title" TEXT NOT NULL,
       "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'REVOKED')),
       "revokedReason" TEXT NULL CHECK ("revokedReason" IS NULL OR "revokedReason" IN ('refunded', 'shop_deleted')),
       "grantedAt" TIMESTAMPTZ NOT NULL,
       "revokedAt" TIMESTAMPTZ NULL,
       "downloadCount" INTEGER NOT NULL DEFAULT 0,
       "lastDownloadAt" TIMESTAMPTZ NULL
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "AssetEntitlement_order_product_uq" ON "AssetEntitlement" ("orderId", "productId")`,
    `CREATE INDEX IF NOT EXISTS "AssetEntitlement_buyer_idx" ON "AssetEntitlement" ("buyerId", "grantedAt" DESC, "id") WHERE "status" = 'ACTIVE'`,
    `CREATE INDEX IF NOT EXISTS "AssetEntitlement_buyer_product_idx" ON "AssetEntitlement" ("buyerId", "productId") WHERE "status" = 'ACTIVE'`,
    `CREATE INDEX IF NOT EXISTS "AssetEntitlement_product_idx" ON "AssetEntitlement" ("productId")`,
    `CREATE INDEX IF NOT EXISTS "AssetEntitlement_asset_idx" ON "AssetEntitlement" ("assetId")`,
    `CREATE INDEX IF NOT EXISTS "AssetEntitlement_shop_idx" ON "AssetEntitlement" ("shopId")`,
    `CREATE TABLE IF NOT EXISTS "AssetDownloadGrant" (
       "tokenHash" CHAR(64) PRIMARY KEY,
       "kind" TEXT NOT NULL CHECK ("kind" IN ('share', 'purchase')),
       "shopId" UUID NOT NULL,
       "assetId" UUID NOT NULL,
       "version" INTEGER NOT NULL,
       "shareLinkId" UUID NULL,
       "entitlementId" UUID NULL,
       "buyerId" TEXT NULL,
       "expiresAt" TIMESTAMPTZ NOT NULL,
       "createdAt" TIMESTAMPTZ NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS "AssetDownloadGrant_expires_idx" ON "AssetDownloadGrant" ("expiresAt")`,
    `CREATE INDEX IF NOT EXISTS "AssetDownloadGrant_shop_idx" ON "AssetDownloadGrant" ("shopId")`,
    `CREATE TABLE IF NOT EXISTS "AssetOrderRevocation" (
       "orderId" UUID PRIMARY KEY,
       "orderVersion" INTEGER NOT NULL,
       "revokedAt" TIMESTAMPTZ NOT NULL
     )`,
  ],
];

module.exports = {
  async up(queryInterface) {
    for (const group of GROUPS) {
      await queryInterface.sequelize.transaction(async (transaction) => {
        await queryInterface.sequelize.query(LOCK_TIMEOUT, { transaction });
        for (const statement of group)
          await queryInterface.sequelize.query(statement, { transaction });
      });
    }
  },

  async down() {
    // Expand steps are additive; the contract step has its own down.
  },
};
