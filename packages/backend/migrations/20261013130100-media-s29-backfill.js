'use strict';

/**
 * S29 photos, backfill step (research.md R-12 step 2). Batched and idempotent; safe to re-run.
 *  1. `rejectCode` from the legacy `rejectReason` (decoder text) - `not a decodable image…` → `not_an_image`, else
 *     `processing_failed`.
 *  2. A history row `null → <current status>` for every photo that has none, so the history is complete.
 *  3. Legacy `post` photos (never linked to anything, S25 is text-only) → `DELETED` with a system history row. Their
 *     purpose becomes `review` in the same update: the purpose CHECK no longer knows `post`, and the purge removes the
 *     rows 7 days later.
 *  4. One `ProductGallery` row (version 1) per product that has links.
 *  5. Validate both CHECK constraints added NOT VALID by the expand step.
 */
const BATCH = 1000;

async function inBatches(sequelize, sql) {
  for (;;) {
    let meta;
    try {
      [, meta] = await sequelize.query(sql, { replacements: { batch: BATCH } });
    } catch (error) {
      throw new Error(`backfill statement failed: ${error.parent?.message ?? error.message}`, { cause: error });
    }
    const count = meta?.rowCount ?? 0;
    if (count < 1) return;
  }
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await inBatches(
      sequelize,
      `UPDATE "Media" SET "rejectCode" = CASE
                WHEN "rejectReason" LIKE 'not a decodable image%' THEN 'not_an_image'
                ELSE 'processing_failed' END
        WHERE "id" IN (SELECT "id" FROM "Media" WHERE "status" = 'REJECTED' AND "rejectCode" IS NULL LIMIT :batch)`,
    );

    await inBatches(
      sequelize,
      `INSERT INTO "MediaStatusHistory" ("mediaId", "fromStatus", "toStatus", "actorType", "rejectCode", "createdAt")
       SELECT m."id", NULL, m."status", 'system', m."rejectCode", m."createdAt"
         FROM "Media" m
        WHERE NOT EXISTS (SELECT 1 FROM "MediaStatusHistory" h WHERE h."mediaId" = m."id")
        LIMIT :batch`,
    );

    await inBatches(
      sequelize,
      `WITH picked AS (
         SELECT "id", "status" FROM "Media" WHERE "purpose" = 'post' AND "status" <> 'DELETED' LIMIT :batch FOR UPDATE
       ), moved AS (
         UPDATE "Media" m SET "status" = 'DELETED', "purpose" = 'review', "version" = m."version" + 1, "updatedAt" = now()
           FROM picked WHERE m."id" = picked."id"
         RETURNING m."id", picked."status" AS "fromStatus"
       )
       INSERT INTO "MediaStatusHistory" ("mediaId", "fromStatus", "toStatus", "actorType")
       SELECT "id", "fromStatus", 'DELETED', 'system' FROM moved`,
    );

    await sequelize.query(
      `INSERT INTO "ProductGallery" ("productId", "shopId", "version")
       SELECT pm."productId", (array_agg(m."shopId"))[1], 1
         FROM "ProductMedia" pm JOIN "Media" m ON m."id" = pm."mediaId"
        WHERE m."shopId" IS NOT NULL
        GROUP BY pm."productId"
       ON CONFLICT ("productId") DO NOTHING`,
    );

    await sequelize.query(`ALTER TABLE "Media" VALIDATE CONSTRAINT "Media_status_check"`);
    await sequelize.query(`ALTER TABLE "Media" VALIDATE CONSTRAINT "Media_purpose_check"`);
  },

  // The data it wrote is valid under the old schema as well (new statuses stay: the expand `down` restores the old
  // CHECK as NOT VALID); nothing to undo.
  async down() {},
};
