'use strict';

/**
 * SD-10 media. Originals are private and uploaded straight to S3 (presigned
 * POST); derived variants are public, immutable, content-addressed. The dHash
 * is split into 4 × 16-bit bands (indexed) for near-duplicate search: two
 * hashes within Hamming distance 3 must share at least one identical band
 * (pigeonhole), so candidates come from 4 index lookups instead of a table scan.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "Media" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NULL REFERENCES "Shop"("id"),
        "uploaderId" UUID NOT NULL REFERENCES "User"("id"),
        "purpose" TEXT NOT NULL CHECK ("purpose" IN ('product', 'review', 'post')),
        "status" TEXT NOT NULL DEFAULT 'PENDING_UPLOAD' CHECK ("status" IN ('PENDING_UPLOAD', 'PROCESSING', 'READY', 'REJECTED')),
        "originalKey" TEXT NOT NULL UNIQUE,
        "variants" JSONB NULL,
        "width" INTEGER NULL,
        "height" INTEGER NULL,
        "dhash" TEXT NULL,
        "dhashB0" INTEGER NULL, "dhashB1" INTEGER NULL, "dhashB2" INTEGER NULL, "dhashB3" INTEGER NULL,
        "possibleDuplicateOf" UUID NULL,
        "rejectReason" TEXT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "Media_b0" ON "Media" ("dhashB0") WHERE status = 'READY';
      CREATE INDEX IF NOT EXISTS "Media_b1" ON "Media" ("dhashB1") WHERE status = 'READY';
      CREATE INDEX IF NOT EXISTS "Media_b2" ON "Media" ("dhashB2") WHERE status = 'READY';
      CREATE INDEX IF NOT EXISTS "Media_b3" ON "Media" ("dhashB3") WHERE status = 'READY';
      CREATE INDEX IF NOT EXISTS "Media_stale_uploads" ON "Media" ("createdAt") WHERE status = 'PENDING_UPLOAD';

      CREATE TABLE IF NOT EXISTS "ProductMedia" (
        "productId" UUID NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
        "mediaId" UUID NOT NULL REFERENCES "Media"("id") ON DELETE CASCADE,
        "position" SMALLINT NOT NULL,
        PRIMARY KEY ("productId", "mediaId")
      );
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "ProductMedia", "Media"`);
  },
};
