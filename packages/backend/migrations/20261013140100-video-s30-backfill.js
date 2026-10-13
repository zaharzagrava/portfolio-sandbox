'use strict';

/**
 * S30 video, backfill step (research.md R-19 step 2). Batched and idempotent; safe to re-run.
 *  1. Titles over 200 characters are cut (the contract step narrows the column).
 *  2. The new required values for legacy rows: size (1,024, the smallest the CHECK allows: the real size of a legacy
 *     upload is unknown), content type, part size, a 24 h session counted from creation, and a source key for rows that
 *     never started their upload. A legacy source key (`videos/<id>/source`) is kept: the object lives where it was
 *     written, and the purge deletes by the stored key.
 *  3. A share token for legacy unlisted rows, so the share-token CHECK holds.
 *  4. `internalError` / `failureCode` from the free-text `error`, `dependsOn` from `deps`.
 *  5. A history row `null → <current status>` for every video that has none, then the legacy statuses that cannot
 *     continue move on (`UPLOADING → EXPIRED`, `PROCESSING → FAILED processing_timeout`) with their own history row.
 *  6. Validate every CHECK that the expand step added NOT VALID.
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
    if ((meta?.rowCount ?? 0) < 1) return;
  }
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // First: a NOT VALID CHECK still applies to every updated row, and a legacy unlisted row without a token fails it.
    await inBatches(
      sequelize,
      `UPDATE "Video"
          SET "shareToken" = left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 43)
        WHERE "id" IN (SELECT "id" FROM "Video" WHERE "visibility" = 'unlisted' AND "shareToken" IS NULL LIMIT :batch)`,
    );

    await inBatches(
      sequelize,
      `UPDATE "Video" SET "title" = left("title", 200)
        WHERE "id" IN (SELECT "id" FROM "Video" WHERE char_length("title") > 200 LIMIT :batch)`,
    );

    await inBatches(
      sequelize,
      `UPDATE "Video" SET "sizeBytes" = COALESCE("sizeBytes", 1024),
                          "contentType" = COALESCE("contentType", 'video/mp4'),
                          "partSize" = COALESCE("partSize", 67108864),
                          "sessionExpiresAt" = COALESCE("sessionExpiresAt", "createdAt" + interval '24 hours')
        WHERE "id" IN (
          SELECT "id" FROM "Video"
           WHERE "sizeBytes" IS NULL OR "contentType" IS NULL OR "partSize" IS NULL OR "sessionExpiresAt" IS NULL
           LIMIT :batch)`,
    );

    await inBatches(
      sequelize,
      `UPDATE "Video" SET "sourceKey" = 'vsrc/' || "id" || '/source'
        WHERE "id" IN (SELECT "id" FROM "Video" WHERE "sourceKey" = 'pending' LIMIT :batch)`,
    );

    await inBatches(
      sequelize,
      `UPDATE "Video"
          SET "internalError" = left("error", 500),
              "failureCode" = COALESCE("failureCode", CASE WHEN "status" = 'FAILED' THEN 'transcode_failed' END)
        WHERE "id" IN (
          SELECT "id" FROM "Video"
           WHERE "internalError" IS NULL AND ("error" IS NOT NULL OR ("status" = 'FAILED' AND "failureCode" IS NULL))
           LIMIT :batch)`,
    );

    await sequelize.query(`UPDATE "VideoTask" SET "dependsOn" = "deps" WHERE "dependsOn" IS NULL AND "deps" IS NOT NULL`);

    await inBatches(
      sequelize,
      `INSERT INTO "VideoStatusHistory" ("videoId", "fromStatus", "toStatus", "actorType", "failureCode", "createdAt")
       SELECT v."id", NULL, v."status", 'system', v."failureCode", v."createdAt"
         FROM "Video" v
        WHERE NOT EXISTS (SELECT 1 FROM "VideoStatusHistory" h WHERE h."videoId" = v."id")
        LIMIT :batch`,
    );

    // Legacy work cannot continue under the new layout (R-19): an upload nobody finished is `EXPIRED`, a video the old
    // pipeline was still processing is `FAILED` `processing_timeout` (retryable: its source is still at `sourceKey`).
    // Each move keeps the initial history row written above and adds its own.
    for (const [from, to, failureCode] of [
      ['UPLOADING', 'EXPIRED', null],
      ['PROCESSING', 'FAILED', 'processing_timeout'],
    ])
      await inBatches(
        sequelize,
        `WITH picked AS (
           SELECT "id" FROM "Video" WHERE "status" = '${from}' LIMIT :batch FOR UPDATE
         ), moved AS (
           UPDATE "Video" v SET "status" = '${to}', "failureCode" = ${failureCode ? `'${failureCode}'` : 'NULL'},
                  "version" = v."version" + 1, "updatedAt" = now()
             FROM picked WHERE v."id" = picked."id"
           RETURNING v."id"
         )
         INSERT INTO "VideoStatusHistory" ("videoId", "fromStatus", "toStatus", "actorType", "failureCode")
         SELECT "id", '${from}', '${to}', 'system', ${failureCode ? `'${failureCode}'` : 'NULL'} FROM moved`,
      );

    for (const [table, name] of [
      ['Video', 'Video_status_check'],
      ['Video', 'Video_failure_code_check'],
      ['Video', 'Video_retry_count_check'],
      ['Video', 'Video_size_check'],
      ['Video', 'Video_content_type_check'],
      ['Video', 'Video_title_length_check'],
      ['Video', 'Video_share_token_check'],
      ['VideoTask', 'VideoTask_status_check'],
      ['VideoTask', 'VideoTask_attempts_check'],
    ])
      await sequelize.query(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${name}"`);
  },

  // The data it wrote is valid under the old schema as well; nothing to undo.
  async down() {},
};
