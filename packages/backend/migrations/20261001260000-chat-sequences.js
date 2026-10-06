'use strict';

/**
 * SD-14: per-channel message sequence numbers, assigned by the DATABASE, so the
 * Rust gateway's plain INSERT (packages/hft-platform/src/db.rs, untouched)
 * gets them for free:
 *   BEFORE INSERT → UPDATE "ChatChannel" SET "lastSeq" = "lastSeq" + 1 RETURNING
 * The channel row lock serializes writers per channel (gap-free, ordered seqs);
 * different channels never contend.
 *
 * The same trigger writes a `chat.message_posted` envelope into the Outbox
 * (transactional outbox via trigger) - offline push notifications work for
 * messages sent through Rust too.
 *
 * Also: client message ids for idempotent sends, and durable read state
 * (`lastReadSeq`) per member.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      SET lock_timeout = '5s';
      ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "lastSeq" BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "lastMessageAt" TIMESTAMPTZ NULL;
      ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "seq" BIGINT NULL;
      ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "clientMessageId" UUID NULL;
      ALTER TABLE "ChatChannelMember" ADD COLUMN IF NOT EXISTS "lastReadSeq" BIGINT NOT NULL DEFAULT 0;
    `);

    // Backfill existing history: seq = position in the channel by uuidv7 id (time order).
    await queryInterface.sequelize.query(`
      UPDATE "ChatMessage" m SET seq = numbered.rn
      FROM (SELECT id, row_number() OVER (PARTITION BY "channelId" ORDER BY id) AS rn FROM "ChatMessage" WHERE seq IS NULL) numbered
      WHERE m.id = numbered.id;
      UPDATE "ChatChannel" c SET "lastSeq" = coalesce((SELECT max(seq) FROM "ChatMessage" WHERE "channelId" = c.id), 0),
                                 "lastMessageAt" = (SELECT max("createdAt") FROM "ChatMessage" WHERE "channelId" = c.id);
    `);

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION chat_message_assign_seq() RETURNS trigger AS $$
      BEGIN
        UPDATE "ChatChannel" SET "lastSeq" = "lastSeq" + 1, "lastMessageAt" = now()
        WHERE id = NEW."channelId"
        RETURNING "lastSeq" INTO NEW.seq;
        IF NEW.seq IS NULL THEN
          RAISE EXCEPTION 'chat channel % not found', NEW."channelId";
        END IF;

        INSERT INTO "Outbox" (id, topic, "aggregateId", "eventName", payload, attempts, "nextAttemptAt", "createdAt")
        VALUES (uuidv7(), 'chat.events', NEW."channelId"::text, 'chat.message_posted',
          jsonb_build_object(
            'eventId', uuidv7(), 'eventName', 'chat.message_posted', 'aggregateType', 'chat',
            'aggregateId', NEW."channelId"::text, 'version', NEW.seq, 'occurredAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'schemaVersion', 1,
            'payload', jsonb_build_object('channelId', NEW."channelId", 'messageId', NEW.id, 'seq', NEW.seq, 'authorId', NEW."authorId", 'preview', left(NEW.body, 120))
          ), 0, now(), now());
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS chat_message_assign_seq_trg ON "ChatMessage";
      CREATE TRIGGER chat_message_assign_seq_trg BEFORE INSERT ON "ChatMessage" FOR EACH ROW EXECUTE FUNCTION chat_message_assign_seq();
    `);

    await queryInterface.sequelize.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_channel_seq_uq" ON "ChatMessage" ("channelId", seq)`);
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_channel_client_id_uq" ON "ChatMessage" ("channelId", "clientMessageId") WHERE "clientMessageId" IS NOT NULL`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS chat_message_assign_seq_trg ON "ChatMessage";
      DROP FUNCTION IF EXISTS chat_message_assign_seq();
      DROP INDEX IF EXISTS "ChatMessage_channel_client_id_uq";
      DROP INDEX IF EXISTS "ChatMessage_channel_seq_uq";
      ALTER TABLE "ChatChannelMember" DROP COLUMN IF EXISTS "lastReadSeq";
      ALTER TABLE "ChatMessage" DROP COLUMN IF EXISTS "clientMessageId", DROP COLUMN IF EXISTS "seq";
      ALTER TABLE "ChatChannel" DROP COLUMN IF EXISTS "lastMessageAt", DROP COLUMN IF EXISTS "lastSeq";
    `);
  },
};
