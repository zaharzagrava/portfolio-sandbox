'use strict';

/**
 * S29 photos, contract step (research.md R-12 step 3). Ships only after the new code is deployed (III.11): one
 * statement per step, each under its own `lock_timeout`.
 *  - the three cross-owner foreign keys go (IX.4: a reference to another domain is a plain id);
 *  - `rejectReason` (decoder text) goes, `rejectCode` replaced it;
 *  - the four old band indexes go (the product-only partial ones replaced them);
 *  - `ProductMedia.mediaId → Media` stays (same owner) but loses `ON DELETE CASCADE`: the purge removes links first.
 */
async function step(sequelize, sql) {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(`SET LOCAL lock_timeout = '3s'`, { transaction });
    await sequelize.query(sql, { transaction });
  });
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await step(sequelize, `ALTER TABLE "Media" DROP CONSTRAINT IF EXISTS "Media_shopId_fkey"`);
    await step(sequelize, `ALTER TABLE "Media" DROP CONSTRAINT IF EXISTS "Media_uploaderId_fkey"`);
    await step(sequelize, `ALTER TABLE "ProductMedia" DROP CONSTRAINT IF EXISTS "ProductMedia_productId_fkey"`);
    await step(sequelize, `ALTER TABLE "Media" DROP COLUMN IF EXISTS "rejectReason"`);
    for (const i of [0, 1, 2, 3]) await step(sequelize, `DROP INDEX IF EXISTS "Media_b${i}"`);
    await step(
      sequelize,
      `ALTER TABLE "ProductMedia"
         DROP CONSTRAINT IF EXISTS "ProductMedia_mediaId_fkey",
         ADD CONSTRAINT "ProductMedia_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") NOT VALID`,
    );
    await sequelize.query(`ALTER TABLE "ProductMedia" VALIDATE CONSTRAINT "ProductMedia_mediaId_fkey"`);
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await step(
      sequelize,
      `ALTER TABLE "ProductMedia"
         DROP CONSTRAINT IF EXISTS "ProductMedia_mediaId_fkey",
         ADD CONSTRAINT "ProductMedia_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE`,
    );
    for (const i of [0, 1, 2, 3])
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "Media_b${i}" ON "Media" ("dhashB${i}") WHERE "status" = 'READY'`,
      );
    await step(sequelize, `ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "rejectReason" TEXT NULL`);
    // The foreign keys come back NOT VALID: rows written since the contract step may reference nothing.
    await step(
      sequelize,
      `ALTER TABLE "Media" ADD CONSTRAINT "Media_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") NOT VALID`,
    ).catch(() => undefined);
    await step(
      sequelize,
      `ALTER TABLE "Media" ADD CONSTRAINT "Media_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User" ("id") NOT VALID`,
    ).catch(() => undefined);
  },
};
