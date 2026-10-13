'use strict';

/**
 * S30 video, expand step (III.11, never run at application start; specs/domains/S30-video/research.md R-19 step 1).
 * Backward compatible: every new `Video` column is nullable or has a default, the old columns and the foreign keys stay
 * (the contract step removes them after the new code is deployed), `VideoTask.deps` only loses its NOT NULL so the new
 * code can write `dependsOn` alone. CHECK constraints are added NOT VALID and validated by the backfill.
 * New: `VideoStatusHistory`, `VideoShopState`, the video and task indexes (built CONCURRENTLY, outside any transaction).
 */
const STATUSES = `'UPLOADING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED', 'DELETED'`;
const FAILURE_CODES = [
  'transcode_failed',
  'task_timeout',
  'storage_unavailable',
  'processing_timeout',
  'not_a_video',
  'no_video_stream',
  'duration_exceeded',
  'duration_too_short',
  'resolution_exceeded',
  'source_size_mismatch',
]
  .map((code) => `'${code}'`)
  .join(', ');
const TASK_STATUSES = `'PENDING', 'QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED', 'CANCELLED'`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        ALTER TABLE "Video"
          ADD COLUMN IF NOT EXISTS "failureCode" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "internalError" VARCHAR(500) NULL,
          ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "sizeBytes" BIGINT NULL,
          ADD COLUMN IF NOT EXISTS "contentType" TEXT NULL,
          ADD COLUMN IF NOT EXISTS "partSize" INTEGER NULL,
          ADD COLUMN IF NOT EXISTS "sessionExpiresAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "shareToken" VARCHAR(43) NULL,
          ADD COLUMN IF NOT EXISTS "productId" UUID NULL,
          ADD COLUMN IF NOT EXISTS "outputs" JSONB NULL,
          ADD COLUMN IF NOT EXISTS "objectsPurgedAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "edgePurgedAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "readyAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1
      `);
      await q(`ALTER TABLE "Video" DROP CONSTRAINT IF EXISTS "Video_status_check"`);
      await q(
        `ALTER TABLE "Video" ADD CONSTRAINT "Video_status_check" CHECK ("status" IN (${STATUSES})) NOT VALID`,
      );
      for (const [name, rule] of [
        ['Video_failure_code_check', `"failureCode" IS NULL OR "failureCode" IN (${FAILURE_CODES})`],
        ['Video_retry_count_check', `"retryCount" BETWEEN 0 AND 3`],
        ['Video_size_check', `"sizeBytes" IS NULL OR "sizeBytes" BETWEEN 1024 AND 21474836480`],
        [
          'Video_content_type_check',
          `"contentType" IS NULL OR "contentType" IN ('video/mp4', 'video/quicktime', 'video/webm')`,
        ],
        ['Video_title_length_check', `char_length("title") <= 200`],
      ]) {
        await q(`ALTER TABLE "Video" DROP CONSTRAINT IF EXISTS "${name}"`);
        await q(`ALTER TABLE "Video" ADD CONSTRAINT "${name}" CHECK (${rule}) NOT VALID`);
      }
      // `(visibility = 'unlisted') = (shareToken IS NOT NULL)`: the backfill gives legacy unlisted rows a token first.
      await q(`ALTER TABLE "Video" DROP CONSTRAINT IF EXISTS "Video_share_token_check"`);
      await q(
        `ALTER TABLE "Video" ADD CONSTRAINT "Video_share_token_check" CHECK (("visibility" = 'unlisted') = ("shareToken" IS NOT NULL)) NOT VALID`,
      );

      await q(`
        ALTER TABLE "VideoTask"
          ADD COLUMN IF NOT EXISTS "dependsOn" TEXT[] NULL,
          ADD COLUMN IF NOT EXISTS "claimedAttempt" INTEGER NULL,
          ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "lastSentAt" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "internalError" VARCHAR(500) NULL,
          ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          ALTER COLUMN "deps" DROP NOT NULL
      `);
      await q(`ALTER TABLE "VideoTask" DROP CONSTRAINT IF EXISTS "VideoTask_status_check"`);
      await q(
        `ALTER TABLE "VideoTask" ADD CONSTRAINT "VideoTask_status_check" CHECK ("status" IN (${TASK_STATUSES})) NOT VALID`,
      );
      await q(`ALTER TABLE "VideoTask" DROP CONSTRAINT IF EXISTS "VideoTask_attempts_check"`);
      await q(
        `ALTER TABLE "VideoTask" ADD CONSTRAINT "VideoTask_attempts_check" CHECK ("attempts" BETWEEN 0 AND 3) NOT VALID`,
      );

      await q(`
        CREATE TABLE IF NOT EXISTS "VideoStatusHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "videoId" UUID NOT NULL,
          "fromStatus" TEXT NULL CHECK ("fromStatus" IN (${STATUSES})),
          "toStatus" TEXT NOT NULL CHECK ("toStatus" IN (${STATUSES})),
          "actorType" TEXT NOT NULL CHECK ("actorType" IN ('user', 'system', 'worker')),
          "actorId" UUID NULL,
          "failureCode" TEXT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "VideoStatusHistory_video_idx" ON "VideoStatusHistory" ("videoId", "createdAt");

        CREATE TABLE IF NOT EXISTS "VideoShopState" (
          "shopId" UUID PRIMARY KEY,
          "suspended" BOOLEAN NOT NULL,
          "shopVersion" INTEGER NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
    });

    // A failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would skip: drop those first.
    const concurrently = [
      [
        'video_shop_created_idx',
        'Video',
        `("shopId", "createdAt" DESC, "id" DESC) WHERE "status" <> 'DELETED'`,
      ],
      [
        'video_product_ready_idx',
        'Video',
        `("productId", "createdAt" DESC, "id" DESC) WHERE "status" = 'READY' AND "visibility" = 'public'`,
      ],
      ['video_status_created_idx', 'Video', `("status", "createdAt")`],
      ['video_shop_uploading_idx', 'Video', `("shopId") WHERE "status" = 'UPLOADING'`],
      [
        'video_product_active_idx',
        'Video',
        `("productId") WHERE "productId" IS NOT NULL AND "status" <> 'DELETED'`,
      ],
      ['video_task_lease_idx', 'VideoTask', `("leaseExpiresAt") WHERE "status" = 'RUNNING'`],
      ['video_task_queued_idx', 'VideoTask', `("updatedAt") WHERE "status" = 'QUEUED'`],
    ];
    for (const [name, table, definition] of concurrently) {
      const [state] = await sequelize.query(
        `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = '${name}'`,
        { type: 'SELECT' },
      );
      if (state && !state.valid) await sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
      await sequelize.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "${table}" ${definition}`);
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const name of [
      'video_shop_created_idx',
      'video_product_ready_idx',
      'video_status_created_idx',
      'video_shop_uploading_idx',
      'video_product_active_idx',
      'video_task_lease_idx',
      'video_task_queued_idx',
    ])
      await sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`DROP TABLE IF EXISTS "VideoShopState", "VideoStatusHistory"`);
      await q(`ALTER TABLE "VideoTask" DROP CONSTRAINT IF EXISTS "VideoTask_attempts_check"`);
      await q(`ALTER TABLE "VideoTask" DROP CONSTRAINT IF EXISTS "VideoTask_status_check"`);
      await q(
        `ALTER TABLE "VideoTask" ADD CONSTRAINT "VideoTask_status_check" CHECK ("status" IN ('PENDING', 'QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED')) NOT VALID`,
      );
      await q(`
        ALTER TABLE "VideoTask"
          DROP COLUMN IF EXISTS "dependsOn",
          DROP COLUMN IF EXISTS "claimedAttempt",
          DROP COLUMN IF EXISTS "leaseExpiresAt",
          DROP COLUMN IF EXISTS "lastSentAt",
          DROP COLUMN IF EXISTS "internalError",
          DROP COLUMN IF EXISTS "createdAt"
      `);
      for (const name of [
        'Video_share_token_check',
        'Video_title_length_check',
        'Video_content_type_check',
        'Video_size_check',
        'Video_retry_count_check',
        'Video_failure_code_check',
      ])
        await q(`ALTER TABLE "Video" DROP CONSTRAINT IF EXISTS "${name}"`);
      await q(`ALTER TABLE "Video" DROP CONSTRAINT IF EXISTS "Video_status_check"`);
      await q(
        `ALTER TABLE "Video" ADD CONSTRAINT "Video_status_check" CHECK ("status" IN ('UPLOADING', 'PROCESSING', 'READY', 'FAILED')) NOT VALID`,
      );
      await q(`
        ALTER TABLE "Video"
          DROP COLUMN IF EXISTS "failureCode",
          DROP COLUMN IF EXISTS "internalError",
          DROP COLUMN IF EXISTS "retryCount",
          DROP COLUMN IF EXISTS "sizeBytes",
          DROP COLUMN IF EXISTS "contentType",
          DROP COLUMN IF EXISTS "partSize",
          DROP COLUMN IF EXISTS "sessionExpiresAt",
          DROP COLUMN IF EXISTS "shareToken",
          DROP COLUMN IF EXISTS "productId",
          DROP COLUMN IF EXISTS "outputs",
          DROP COLUMN IF EXISTS "objectsPurgedAt",
          DROP COLUMN IF EXISTS "edgePurgedAt",
          DROP COLUMN IF EXISTS "readyAt",
          DROP COLUMN IF EXISTS "version"
      `);
    });
  },
};
