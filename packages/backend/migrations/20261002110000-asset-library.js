'use strict';

/**
 * SD-25 asset library + digital products. Files are ordered lists of
 * content-addressed chunks (FastCDC); chunks are deduplicated PER SHOP
 * (cross-tenant dedupe would let a shop probe whether another shop holds a
 * file) and reference-counted for garbage collection.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "Asset" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "path" TEXT NOT NULL CHECK ("path" ~ '^/[^\\x00]{1,1000}$'),
        "currentVersion" INTEGER NOT NULL DEFAULT 0,
        "deleted" BOOLEAN NOT NULL DEFAULT FALSE,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "Asset_shop_path_uq" ON "Asset" ("shopId", "path") WHERE NOT deleted;

      CREATE TABLE IF NOT EXISTS "AssetVersion" (
        "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE CASCADE,
        "version" INTEGER NOT NULL,
        "size" BIGINT NOT NULL,
        "chunks" TEXT[] NOT NULL,
        "createdBy" UUID NOT NULL,
        "deviceId" TEXT NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("assetId", "version")
      );

      CREATE TABLE IF NOT EXISTS "AssetChunk" (
        "shopId" UUID NOT NULL,
        "hash" CHAR(64) NOT NULL,
        "size" INTEGER NOT NULL,
        "refCount" INTEGER NOT NULL DEFAULT 0 CHECK ("refCount" >= 0),
        "unreferencedSince" TIMESTAMPTZ NULL DEFAULT now(),
        PRIMARY KEY ("shopId", "hash")
      );
      CREATE INDEX IF NOT EXISTS "AssetChunk_gc_idx" ON "AssetChunk" ("unreferencedSince") WHERE "refCount" = 0;

      CREATE TABLE IF NOT EXISTS "AssetSyncState" ("shopId" UUID PRIMARY KEY, "lastSeq" BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS "AssetChange" (
        "shopId" UUID NOT NULL,
        "seq" BIGINT NOT NULL,
        "assetId" UUID NOT NULL,
        "path" TEXT NOT NULL,
        "version" INTEGER NOT NULL,
        "kind" TEXT NOT NULL CHECK ("kind" IN ('upsert', 'delete')),
        "at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("shopId", "seq")
      );

      CREATE TABLE IF NOT EXISTS "AssetShareLink" (
        "tokenHash" CHAR(64) PRIMARY KEY,
        "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE CASCADE,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "maxDownloads" INTEGER NULL,
        "downloads" INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS "DigitalProduct" (
        "productId" UUID PRIMARY KEY REFERENCES "Product"("id") ON DELETE CASCADE,
        "assetId" UUID NOT NULL REFERENCES "Asset"("id")
      );
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "DigitalProduct", "AssetShareLink", "AssetChange", "AssetSyncState", "AssetChunk", "AssetVersion", "Asset"`);
  },
};
