'use strict';

/**
 * F-05: the outbox becomes the transport for all domain events.
 *  - `topic` ENUM → TEXT: every new aggregate gets its own `<aggregate>.events`
 *    topic; an ENUM would need a migration per topic. (Converting rewrites the
 *    table - fine for the outbox, which only holds unpublished/recent rows.)
 *  - `aggregateId` → Kafka message key (per-aggregate ordering) and the
 *    Debezium Outbox Event Router's key field.
 *  - `eventName` → Debezium event type header / debugging.
 *  - partial index on unpublished rows: the poller's query only ever scans
 *    pending rows, so the index stays tiny no matter how large the table grows.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '5s'`, { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE "Outbox" ALTER COLUMN "topic" TYPE TEXT USING "topic"::text;
         DROP TYPE IF EXISTS "enum_Outbox_topic";
         ALTER TABLE "Outbox" ADD COLUMN IF NOT EXISTS "aggregateId" TEXT NULL;
         ALTER TABLE "Outbox" ADD COLUMN IF NOT EXISTS "eventName" TEXT NULL;
         CREATE INDEX IF NOT EXISTS "Outbox_pending_idx" ON "Outbox" ("nextAttemptAt") WHERE "publishedAt" IS NULL;`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS "Outbox_pending_idx";
       ALTER TABLE "Outbox" DROP COLUMN IF EXISTS "eventName";
       ALTER TABLE "Outbox" DROP COLUMN IF EXISTS "aggregateId";`,
    );
  },
};
