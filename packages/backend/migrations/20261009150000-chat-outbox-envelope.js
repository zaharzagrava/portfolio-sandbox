'use strict';

/**
 * S53 row contract for the chat trigger: the `ChatMessage` insert trigger is a framework-free outbox writer (the
 * Rust gateway inserts plain rows), so its outbox row must satisfy the database contract of 20261009130000:
 * `aggregateType`, a dotted `type`, and an envelope with `type`, `version` (contract, 1) and `aggregateVersion`
 * (the channel sequence number, strictly increasing per channel). Same function, same trigger, same payload;
 * only the envelope field names change (`eventName` → `type`, `version` → `aggregateVersion`, `schemaVersion` → `version`).
 * `eventName` is still written (mirror of `type`) until the contract migration drops it.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION chat_message_assign_seq() RETURNS trigger AS $$
      BEGIN
        UPDATE "ChatChannel" SET "lastSeq" = "lastSeq" + 1, "lastMessageAt" = now()
        WHERE id = NEW."channelId"
        RETURNING "lastSeq" INTO NEW.seq;
        IF NEW.seq IS NULL THEN
          RAISE EXCEPTION 'chat channel % not found', NEW."channelId";
        END IF;

        INSERT INTO "Outbox" (id, topic, "aggregateId", "aggregateType", "type", "eventName", payload, attempts, "nextAttemptAt", "createdAt")
        VALUES (uuidv7(), 'chat.events', NEW."channelId"::text, 'chat', 'chat.message_posted', 'chat.message_posted',
          jsonb_build_object(
            'eventId', uuidv7(), 'type', 'chat.message_posted', 'version', 1, 'aggregateType', 'chat',
            'aggregateId', NEW."channelId"::text, 'aggregateVersion', NEW.seq,
            'occurredAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'payload', jsonb_build_object('channelId', NEW."channelId", 'messageId', NEW.id, 'seq', NEW.seq, 'authorId', NEW."authorId", 'preview', left(NEW.body, 120))
          ), 0, now(), now());
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
  },

  async down(queryInterface) {
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
    `);
  },
};
