'use strict';

/**
 * S07 bulk import, data step (III.11; specs/domains/S07-bulk-import/data-model.md). Maps the pre-release six-state
 * rows onto the new shape in bounded batches, each its own transaction, and is idempotent (a second run finds nothing
 * to change): legacy `objectKey`/`uploadId`/`checkpointRow`/`error` become `storageKey`/`uploadHandle`/`lastRow`/
 * `failureCode`; non-final rows older than 24 hours become `EXPIRED`; a legacy `SCANNING`/`PROCESSING` row cannot be
 * resumed by byte offset and becomes `FAILED internal_error`; the rest get their slots; every job gets a first history
 * row; then the two constraints added `NOT VALID` by the expand step are validated.
 */
const BATCH = 1000;
const ACTIVE = `('PENDING_UPLOAD','UPLOADED','SCANNING','PROCESSING')`;

const hasColumn = async (queryInterface, column) => {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'ImportJob' AND column_name = :column`,
    { replacements: { column } },
  );
  return rows.length > 0;
};

/** Each statement is one bounded batch; it returns how many rows it changed. */
const backfills = (legacy) => [
  ...(legacy.objectKey
    ? [
        `WITH b AS (SELECT "id" FROM "ImportJob" WHERE "storageKey" IS NULL ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
         UPDATE "ImportJob" j SET "storageKey" = j."objectKey" FROM b WHERE j."id" = b."id"`,
      ]
    : []),
  ...(legacy.uploadId
    ? [
        `WITH b AS (SELECT "id" FROM "ImportJob" WHERE "uploadHandle" IS NULL AND "uploadId" IS NOT NULL AND "status" = 'PENDING_UPLOAD' ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
         UPDATE "ImportJob" j SET "uploadHandle" = j."uploadId" FROM b WHERE j."id" = b."id"`,
      ]
    : []),
  ...(legacy.checkpointRow
    ? [
        `WITH b AS (SELECT "id" FROM "ImportJob" WHERE "lastRow" = 0 AND "checkpointRow" <> 0 ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
         UPDATE "ImportJob" j SET "lastRow" = j."checkpointRow" FROM b WHERE j."id" = b."id"`,
      ]
    : []),
  // legacy rows that cannot be resumed by byte offset
  `WITH b AS (SELECT "id" FROM "ImportJob" WHERE "status" IN ('SCANNING','PROCESSING') ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED),
        u AS (UPDATE "ImportJob" j SET "status" = 'FAILED', "failureCode" = 'internal_error', "finishedAt" = j."updatedAt",
                     "leaseHolder" = NULL, "leaseExpiresAt" = NULL
               FROM b WHERE j."id" = b."id" RETURNING j."id", j."shopId", j."updatedAt")
   INSERT INTO "ImportJobHistory" ("importId","shopId","fromStatus","toStatus","reason","at")
   SELECT "id","shopId",NULL,'FAILED','legacy_migration',"updatedAt" FROM u`,
  // abandoned legacy work
  `WITH b AS (SELECT "id" FROM "ImportJob" WHERE "status" IN ('PENDING_UPLOAD','UPLOADED') AND "createdAt" < now() - interval '24 hours' ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED),
        u AS (UPDATE "ImportJob" j SET "status" = 'EXPIRED', "finishedAt" = j."updatedAt", "uploadHandle" = NULL
               FROM b WHERE j."id" = b."id" RETURNING j."id", j."shopId", j."updatedAt")
   INSERT INTO "ImportJobHistory" ("importId","shopId","fromStatus","toStatus","reason","at")
   SELECT "id","shopId",NULL,'EXPIRED','legacy_migration',"updatedAt" FROM u`,
  // failed legacy rows get a stable failure code
  `WITH b AS (SELECT "id" FROM "ImportJob" WHERE "status" = 'FAILED' AND "failureCode" IS NULL ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
   UPDATE "ImportJob" j SET "failureCode" = 'internal_error' FROM b WHERE j."id" = b."id"`,
  // counters: the legacy table counted valid rows in rowsProcessed and bad rows in rowsFailed
  `WITH b AS (SELECT "id" FROM "ImportJob"
               WHERE "rowsProcessed" <> "rowsCreated" + "rowsUpdated" + "rowsUnchanged" + "rowsFailed"
               ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
   UPDATE "ImportJob" j SET "rowsCreated" = GREATEST(j."rowsProcessed" - j."rowsFailed", 0),
          "rowsUpdated" = 0, "rowsUnchanged" = 0,
          "rowsProcessed" = GREATEST(j."rowsProcessed", j."rowsFailed")
     FROM b WHERE j."id" = b."id"`,
  `WITH b AS (SELECT "id" FROM "ImportJob" WHERE "sizeBytes" NOT BETWEEN 1 AND 5368709120 ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
   UPDATE "ImportJob" j SET "sizeBytes" = LEAST(GREATEST(j."sizeBytes", 1), 5368709120) FROM b WHERE j."id" = b."id"`,
  // slots for what is still active: the oldest three of a shop keep one, the others are cancelled
  `WITH ranked AS (SELECT "id", row_number() OVER (PARTITION BY "shopId" ORDER BY "createdAt", "id") AS rn
                    FROM "ImportJob" WHERE "status" IN ${ACTIVE}),
        b AS (SELECT r."id", r.rn FROM ranked r JOIN "ImportJob" j ON j."id" = r."id" WHERE j."slot" IS NULL ORDER BY r."id" LIMIT ${BATCH}),
        u AS (UPDATE "ImportJob" j SET "slot" = CASE WHEN b.rn <= 3 THEN b.rn END::smallint,
                     "status" = CASE WHEN b.rn <= 3 THEN j."status" ELSE 'CANCELLED' END,
                     "finishedAt" = CASE WHEN b.rn <= 3 THEN j."finishedAt" ELSE j."updatedAt" END
               FROM b WHERE j."id" = b."id" RETURNING j."id", j."shopId", j."updatedAt", j."status", b.rn)
   INSERT INTO "ImportJobHistory" ("importId","shopId","fromStatus","toStatus","reason","at")
   SELECT "id","shopId",NULL,'CANCELLED','legacy_over_cap',"updatedAt" FROM u WHERE rn > 3`,
  // a first history row for every job that has none
  `INSERT INTO "ImportJobHistory" ("importId","shopId","fromStatus","toStatus","reason","at")
   SELECT j."id", j."shopId", NULL, j."status", 'legacy_migration', j."createdAt"
     FROM "ImportJob" j
    WHERE NOT EXISTS (SELECT 1 FROM "ImportJobHistory" h WHERE h."importId" = j."id")
      AND j."id" IN (SELECT "id" FROM "ImportJob" j2 WHERE NOT EXISTS (SELECT 1 FROM "ImportJobHistory" h2 WHERE h2."importId" = j2."id") ORDER BY "id" LIMIT ${BATCH})`,
];

module.exports = {
  backfills,
  async up(queryInterface) {
    const legacy = {
      objectKey: await hasColumn(queryInterface, 'objectKey'),
      uploadId: await hasColumn(queryInterface, 'uploadId'),
      checkpointRow: await hasColumn(queryInterface, 'checkpointRow'),
    };
    for (const sql of backfills(legacy)) {
      for (;;) {
        const changed = await queryInterface.sequelize.transaction(
          async (transaction) => {
            await queryInterface.sequelize.query(
              `SET LOCAL lock_timeout = '5s'`,
              { transaction },
            );
            const [, meta] = await queryInterface.sequelize.query(sql, {
              transaction,
            });
            return meta && typeof meta.rowCount === 'number'
              ? meta.rowCount
              : 0;
          },
        );
        if (changed === 0) break;
      }
    }
    await queryInterface.sequelize.query(
      `ALTER TABLE "ImportJob" VALIDATE CONSTRAINT "ImportJob_counters_sum"`,
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "ImportJob" VALIDATE CONSTRAINT "ImportJob_size_range"`,
    );
  },
  async down() {
    // Data mappings are not reversed; the legacy columns are untouched until the contract step.
  },
};
