'use strict';

/**
 * S23 (expand only, idempotent): the durable pin and its version on "LiveStream", the foreign key to "Shop" (another
 * owner's table, IX.4) goes, and mutes become a durable table owned by launch-events (before, a Redis set).
 * `lock_timeout` keeps a busy table from blocking the deploy.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run(`SET LOCAL lock_timeout = '5s'`);
      await run(`ALTER TABLE "LiveStream" ADD COLUMN IF NOT EXISTS "pin" JSONB NULL`);
      await run(
        `ALTER TABLE "LiveStream" ADD COLUMN IF NOT EXISTS "pinVersion" INTEGER NOT NULL DEFAULT 0`,
      );
      await run(
        `ALTER TABLE "LiveStream" DROP CONSTRAINT IF EXISTS "LiveStream_shopId_fkey"`,
      );
      await run(`
        CREATE TABLE IF NOT EXISTS "LiveMute" (
          "streamId" UUID NOT NULL REFERENCES "LiveStream"("id"),
          "userId" UUID NOT NULL,
          "mutedBy" UUID NOT NULL,
          "mutedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("streamId", "userId")
        )
      `);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run(`SET LOCAL lock_timeout = '5s'`);
      await run(`DROP TABLE IF EXISTS "LiveMute"`);
      await run(`ALTER TABLE "LiveStream" DROP COLUMN IF EXISTS "pinVersion"`);
      await run(`ALTER TABLE "LiveStream" DROP COLUMN IF EXISTS "pin"`);
      await run(
        `ALTER TABLE "LiveStream" ADD CONSTRAINT "LiveStream_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") NOT VALID`,
      );
    });
  },
};
