'use strict';

/**
 * SD-43 RAG knowledge base. Chunks carry the permission columns of their
 * document (denormalised) so the scope filter sits INSIDE the vector/FTS
 * query - results are never post-filtered.
 *
 * halfvec(1024): half the memory of vector(1024) for the HNSW graph, recall
 * loss negligible for cosine retrieval (D9 / scale block).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';
        CREATE TABLE IF NOT EXISTS "KnowledgeDocument" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          -- NULL shop = platform document (seller help center articles).
          "shopId" UUID NULL REFERENCES "Shop"("id"),
          "productId" UUID NULL REFERENCES "Product"("id") ON DELETE CASCADE,
          "visibility" TEXT NOT NULL CHECK ("visibility" IN ('PUBLIC', 'SHOP_PRIVATE', 'PLATFORM')),
          "title" TEXT NOT NULL CHECK (length("title") <= 200),
          "format" TEXT NOT NULL CHECK ("format" IN ('MARKDOWN', 'PDF')),
          "storageKey" TEXT NOT NULL,
          "contentHash" CHAR(64) NULL,
          "status" TEXT NOT NULL DEFAULT 'AWAITING_UPLOAD' CHECK ("status" IN ('AWAITING_UPLOAD', 'QUEUED', 'PROCESSING', 'READY', 'FAILED', 'DELETED')),
          "error" TEXT NULL,
          "chunkCount" INTEGER NOT NULL DEFAULT 0,
          "indexedHash" CHAR(64) NULL,
          "embeddingModel" TEXT NULL,
          "createdBy" UUID NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (("visibility" = 'PLATFORM') = ("shopId" IS NULL))
        );
        -- Same bytes uploaded twice into the same scope = the same document (content-hash idempotency).
        CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeDocument_scope_hash"
          ON "KnowledgeDocument" (COALESCE("shopId", '00000000-0000-0000-0000-000000000000'::uuid), COALESCE("productId", '00000000-0000-0000-0000-000000000000'::uuid), "visibility", "contentHash")
          WHERE "contentHash" IS NOT NULL AND "status" <> 'DELETED';

        CREATE TABLE IF NOT EXISTS "KnowledgeChunk" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "documentId" UUID NOT NULL REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE,
          "shopId" UUID NULL,
          "productId" UUID NULL,
          "visibility" TEXT NOT NULL,
          "ordinal" INTEGER NOT NULL,
          "headingPath" TEXT NOT NULL,
          "page" INTEGER NULL,
          "content" TEXT NOT NULL,
          "tokens" INTEGER NOT NULL,
          "embedding" halfvec(1024) NOT NULL,
          "tsv" tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('english', "headingPath"), 'A') || setweight(to_tsvector('english', "content"), 'B')
          ) STORED,
          UNIQUE ("documentId", "ordinal")
        );
        CREATE INDEX IF NOT EXISTS "KnowledgeChunk_embedding_hnsw" ON "KnowledgeChunk" USING hnsw ("embedding" halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
        CREATE INDEX IF NOT EXISTS "KnowledgeChunk_tsv" ON "KnowledgeChunk" USING gin ("tsv");
        CREATE INDEX IF NOT EXISTS "KnowledgeChunk_product" ON "KnowledgeChunk" ("productId") WHERE "productId" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "KnowledgeChunk_shop" ON "KnowledgeChunk" ("shopId", "visibility");
        `,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "KnowledgeChunk", "KnowledgeDocument"`);
  },
};
