'use strict';

/**
 * S47 knowledge documents, backfill step (research.md R-5). Batched and idempotent; safe to re-run. Drops nothing.
 *  1. `KnowledgeChunk.embeddingModel` from the document that owns the chunk, in batches of 5,000.
 *  2. `failureCode` of `FAILED` documents from the legacy free-text `error` (unknown text → `unparseable`).
 *  3. `contentSize` of markdown documents is unknown for old rows and stays NULL; `queuedAt` of `QUEUED` rows is set so
 *     the sweep sees their age; `deletedAt` of `DELETED` rows is set from `updatedAt`.
 *  4. Validate the two CHECK constraints added NOT VALID by the expand step (out-of-range token counts are clamped
 *     first: the chunker never writes them, so this only protects a hand-edited database).
 */
const BATCH = 5000;

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

    await inBatches(
      sequelize,
      `UPDATE "KnowledgeChunk" c SET "embeddingModel" = COALESCE(d."embeddingModel", 'unknown')
         FROM "KnowledgeDocument" d
        WHERE c."documentId" = d."id"
          AND c."id" IN (SELECT "id" FROM "KnowledgeChunk" WHERE "embeddingModel" IS NULL LIMIT :batch)`,
    );

    await sequelize.query(
      `UPDATE "KnowledgeDocument" SET "failureCode" = CASE
              WHEN "error" ILIKE 'Not a PDF%' THEN 'not_a_pdf'
              WHEN "error" ILIKE 'No extractable text%' THEN 'no_text'
              WHEN "error" ILIKE 'Too many chunks%' THEN 'too_many_chunks'
              WHEN "error" ILIKE 'Document too large%' THEN 'size_mismatch'
              WHEN "error" ILIKE '%embedding%' OR "error" ILIKE '%voyage%' OR "error" ILIKE '%timeout%' OR "error" ILIKE '%fetch failed%'
                THEN 'embedding_unavailable'
              ELSE 'unparseable' END
        WHERE "status" = 'FAILED' AND "failureCode" IS NULL`,
    );
    await sequelize.query(
      `UPDATE "KnowledgeDocument" SET "queuedAt" = "updatedAt" WHERE "status" = 'QUEUED' AND "queuedAt" IS NULL`,
    );
    await sequelize.query(
      `UPDATE "KnowledgeDocument" SET "deletedAt" = "updatedAt" WHERE "status" = 'DELETED' AND "deletedAt" IS NULL`,
    );

    await sequelize.query(
      `UPDATE "KnowledgeChunk" SET "tokens" = LEAST(800, GREATEST(1, "tokens")) WHERE "tokens" NOT BETWEEN 1 AND 800`,
    );
    await sequelize.query(`ALTER TABLE "KnowledgeDocument" VALIDATE CONSTRAINT "KnowledgeDocument_failureCode_check"`);
    await sequelize.query(`ALTER TABLE "KnowledgeChunk" VALIDATE CONSTRAINT "KnowledgeChunk_tokens_check"`);
  },

  // Nothing to undo: the backfill only fills columns the expand step added.
  async down() {},
};
