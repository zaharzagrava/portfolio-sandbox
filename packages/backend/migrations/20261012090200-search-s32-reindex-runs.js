'use strict';

/**
 * S32 discovery, expand step 3: "SearchReindexRun" (one row per reindex or rollback run, single active run enforced
 * by a partial unique index on a constant) and "SearchReindexRunHistory" (one row per status move).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await t(`SET LOCAL lock_timeout = '3s'`);
      await t(`
        CREATE TABLE IF NOT EXISTS "SearchReindexRun" (
          "runId" UUID PRIMARY KEY,
          "kind" TEXT NOT NULL CHECK ("kind" IN ('REINDEX','ROLLBACK')),
          "status" TEXT NOT NULL CHECK ("status" IN
            ('QUEUED','BUILDING','CATCHING_UP','COMPLETED','FAILED','CANCELLED')),
          "mappingVersion" INTEGER NOT NULL,
          "embeddingModelVersion" TEXT NOT NULL,
          "index" TEXT NULL,
          "previousIndex" TEXT NULL,
          "previousRetiresAt" TIMESTAMPTZ NULL,
          "replayPosition" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "documents" BIGINT NOT NULL DEFAULT 0,
          "ledger" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "failureReason" TEXT NULL,
          "switchingAt" TIMESTAMPTZ NULL,
          "requestedBy" UUID NULL,
          "startedAt" TIMESTAMPTZ NULL,
          "finishedAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "SearchReindexRun_single_active_key"
          ON "SearchReindexRun" ((true)) WHERE "status" IN ('QUEUED','BUILDING','CATCHING_UP');
        CREATE INDEX IF NOT EXISTS "SearchReindexRun_created_idx"
          ON "SearchReindexRun" ("createdAt" DESC, "runId" DESC);

        CREATE TABLE IF NOT EXISTS "SearchReindexRunHistory" (
          "historyId" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          "runId" UUID NOT NULL,
          "fromStatus" TEXT NULL,
          "toStatus" TEXT NOT NULL,
          "at" TIMESTAMPTZ NOT NULL,
          "detail" JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS "SearchReindexRunHistory_run_idx"
          ON "SearchReindexRunHistory" ("runId", "historyId");
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS "SearchReindexRunHistory";
      DROP TABLE IF EXISTS "SearchReindexRun";
    `);
  },
};
