'use strict';

/** SD-26 videos + their transcoding DAG (one row per task, status per node). */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "Video" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "uploaderId" UUID NOT NULL REFERENCES "User"("id"),
        "title" TEXT NOT NULL,
        "visibility" TEXT NOT NULL DEFAULT 'public' CHECK ("visibility" IN ('public', 'unlisted')),
        "status" TEXT NOT NULL DEFAULT 'UPLOADING' CHECK ("status" IN ('UPLOADING', 'PROCESSING', 'READY', 'FAILED')),
        "sourceKey" TEXT NOT NULL,
        "uploadId" TEXT NULL,
        "durationSec" NUMERIC(10, 3) NULL,
        "width" INTEGER NULL,
        "height" INTEGER NULL,
        "masterKey" TEXT NULL,
        "posterKey" TEXT NULL,
        "error" TEXT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS "VideoTask" (
        "videoId" UUID NOT NULL REFERENCES "Video"("id") ON DELETE CASCADE,
        "name" TEXT NOT NULL,
        "deps" TEXT[] NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED')),
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "output" JSONB NULL,
        "error" TEXT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("videoId", "name")
      );
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "VideoTask", "Video"`);
  },
};
