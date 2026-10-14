'use strict';

/**
 * S24 expand (specs/domains/S24-product-chat/data-model.md section 4, step 1). Additive only: nothing the running
 * code reads changes shape.
 *
 *  - `ChatChannel.activeMemberCount`, `ChatChannel.deleteEpoch`, `ChatMessage.deletedBy`
 *  - `ChatMessageIndex`: the chat-owned cross-month guard (PK `(channelId, seq)`, author-scoped client-id key)
 *  - `ChatMessage_new`: the monthly-partitioned successor of `ChatMessage` (oldest message month .. current + 3,
 *    plus a default partition), filled by scripts/chat-s24-backfill.ts and swapped in by the contract migration
 *  - trigger `chat_member_count`, member index and read-position check
 *  - the new `chat_message_assign_seq` function. The old table's trigger runs it from now on, so every message
 *    inserted while the backfill runs already gets its index row (the backfill is `ON CONFLICT DO NOTHING`).
 *
 * `down` is meant for a throwaway database only.
 */
const FUNCTION_SQL = `
  CREATE OR REPLACE FUNCTION chat_message_assign_seq() RETURNS trigger AS $$
  DECLARE
    v_hex text;
    v_md5 text;
    v_event uuid;
  BEGIN
    UPDATE "ChatChannel"
       SET "lastSeq" = "lastSeq" + 1,
           "lastMessageAt" = GREATEST(coalesce("lastMessageAt", NEW."createdAt"), NEW."createdAt")
     WHERE id = NEW."channelId"
    RETURNING "lastSeq" INTO NEW.seq;
    IF NEW.seq IS NULL THEN
      RAISE EXCEPTION 'chat channel % not found', NEW."channelId";
    END IF;

    -- cross-month uniqueness of (channel, seq) and (channel, author, clientMessageId); a unique violation aborts the
    -- statement and rolls the sequence increment back, so a rejected write consumes nothing
    INSERT INTO "ChatMessageIndex" ("channelId", seq, "messageId", "createdAt", "authorId", "clientMessageId", "bodyHash")
    VALUES (NEW."channelId", NEW.seq, NEW.id, NEW."createdAt", NEW."authorId", NEW."clientMessageId",
            sha256(convert_to(NEW.body || chr(31) || coalesce(NEW."replyToId"::text, ''), 'UTF8')));

    -- an author has read what they wrote
    UPDATE "ChatChannelMember" SET "lastReadSeq" = GREATEST("lastReadSeq", NEW.seq)
     WHERE "channelId" = NEW."channelId" AND "userId" = NEW."authorId";

    -- deterministic event id: the message id's 48-bit timestamp prefix, version 7, variant 8, md5 tail (R-03)
    v_hex := replace(NEW.id::text, '-', '');
    v_md5 := md5('chat-msg:' || NEW.id::text);
    v_event := (substr(v_hex, 1, 8) || '-' || substr(v_hex, 9, 4) || '-7' || substr(v_md5, 1, 3) || '-8' ||
                substr(v_md5, 4, 3) || '-' || substr(v_md5, 7, 12))::uuid;

    INSERT INTO "Outbox" (id, topic, "aggregateId", "aggregateType", "type", "eventName", payload, attempts, "nextAttemptAt", "createdAt")
    VALUES (v_event, 'chat.events', NEW."channelId"::text, 'chat', 'chat.message_posted', 'chat.message_posted',
      jsonb_build_object(
        'eventId', v_event, 'type', 'chat.message_posted', 'version', 1, 'aggregateType', 'chat',
        'aggregateId', NEW."channelId"::text, 'aggregateVersion', NEW.seq,
        'occurredAt', to_char(NEW."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'payload', jsonb_build_object('channelId', NEW."channelId", 'messageId', NEW.id, 'seq', NEW.seq,
                                      'authorId', NEW."authorId", 'preview', left(NEW.body, 120))
      ), 0, now(), now())
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;

const OLD_FUNCTION_SQL = `
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
`;

const MEMBER_COUNT_SQL = `
  CREATE OR REPLACE FUNCTION chat_member_count() RETURNS trigger AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status = 'ACTIVE' THEN
        UPDATE "ChatChannel" SET "activeMemberCount" = "activeMemberCount" + 1 WHERE id = NEW."channelId";
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      IF OLD.status = 'ACTIVE' THEN
        UPDATE "ChatChannel" SET "activeMemberCount" = GREATEST("activeMemberCount" - 1, 0) WHERE id = OLD."channelId";
      END IF;
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
      IF NEW.status = 'ACTIVE' THEN
        UPDATE "ChatChannel" SET "activeMemberCount" = "activeMemberCount" + 1 WHERE id = NEW."channelId";
      ELSIF OLD.status = 'ACTIVE' THEN
        UPDATE "ChatChannel" SET "activeMemberCount" = GREATEST("activeMemberCount" - 1, 0) WHERE id = NEW."channelId";
      END IF;
    END IF;
    RETURN NULL;
  END;
  $$ LANGUAGE plpgsql;
`;

const PARTITIONS_SQL = `
  DO $$
  DECLARE
    m date;
    first_month date;
    last_month date;
    part text;
  BEGIN
    SELECT date_trunc('month', coalesce(min("createdAt"), now()) AT TIME ZONE 'UTC')::date INTO first_month FROM "ChatMessage";
    first_month := LEAST(first_month, date_trunc('month', now() AT TIME ZONE 'UTC')::date);
    last_month := (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '3 months')::date;
    m := first_month;
    WHILE m <= last_month LOOP
      part := 'ChatMessage_' || to_char(m, 'YYYY_MM');
      EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF "ChatMessage_new" FOR VALUES FROM (%L) TO (%L)',
        part, (m::timestamp AT TIME ZONE 'UTC'), ((m + interval '1 month')::timestamp AT TIME ZONE 'UTC'));
      EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I ("channelId", seq)', part || '_channel_seq_uq', part);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("channelId", "createdAt" DESC)', part || '_channel_created_idx', part);
      m := (m + interval '1 month')::date;
    END LOOP;
    CREATE TABLE IF NOT EXISTS "ChatMessage_default" PARTITION OF "ChatMessage_new" DEFAULT;
    CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_default_channel_seq_uq" ON "ChatMessage_default" ("channelId", seq);
    CREATE INDEX IF NOT EXISTS "ChatMessage_default_channel_created_idx" ON "ChatMessage_default" ("channelId", "createdAt" DESC);
  END $$;
`;

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`
      SET lock_timeout = '3s';
      ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "activeMemberCount" INT NOT NULL DEFAULT 0;
      ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "deleteEpoch" BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "deletedBy" UUID NULL;

      CREATE TABLE IF NOT EXISTS "ChatMessageIndex" (
        "channelId" UUID NOT NULL,
        seq BIGINT NOT NULL,
        "messageId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL,
        "authorId" UUID NOT NULL,
        "clientMessageId" UUID NULL,
        "bodyHash" BYTEA NOT NULL,
        PRIMARY KEY ("channelId", seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessageIndex_client_uq"
        ON "ChatMessageIndex" ("channelId", "authorId", "clientMessageId") WHERE "clientMessageId" IS NOT NULL;
      CREATE INDEX IF NOT EXISTS "ChatMessageIndex_message_idx" ON "ChatMessageIndex" ("messageId");

      CREATE TABLE IF NOT EXISTS "ChatMessage_new" (
        id UUID NOT NULL,
        "channelId" UUID NOT NULL REFERENCES "ChatChannel"(id) ON UPDATE CASCADE ON DELETE CASCADE,
        seq BIGINT NOT NULL,
        "authorId" UUID NOT NULL,
        body TEXT NOT NULL,
        "replyToId" UUID NULL,
        "clientMessageId" UUID NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMPTZ NULL,
        "deletedBy" UUID NULL,
        PRIMARY KEY (id, "createdAt")
      ) PARTITION BY RANGE ("createdAt");
    `);
    await q(PARTITIONS_SQL);

    await q(`SET lock_timeout = '3s'; ${MEMBER_COUNT_SQL}`);
    await q(`
      SET lock_timeout = '3s';
      DROP TRIGGER IF EXISTS chat_member_count_trg ON "ChatChannelMember";
      CREATE TRIGGER chat_member_count_trg AFTER INSERT OR DELETE OR UPDATE OF status ON "ChatChannelMember"
        FOR EACH ROW EXECUTE FUNCTION chat_member_count();
      ALTER TABLE "ChatChannelMember" ADD CONSTRAINT "ChatChannelMember_lastReadSeq_nonneg" CHECK ("lastReadSeq" >= 0) NOT VALID;
    `);
    await q(`ALTER TABLE "ChatChannelMember" VALIDATE CONSTRAINT "ChatChannelMember_lastReadSeq_nonneg"`);

    // the function now also feeds ChatMessageIndex, so the old table's trigger keeps the index current during the backfill
    await q(`SET lock_timeout = '3s'; ${FUNCTION_SQL}`);

    // outside any transaction
    await q(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatChannelMember_user_active_idx" ON "ChatChannelMember" ("userId", "channelId") WHERE status = 'ACTIVE'`,
    );
    await q(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_deleted_idx" ON "ChatMessage" ("deletedAt") WHERE "deletedAt" IS NOT NULL`,
    );
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      DROP INDEX IF EXISTS "ChatMessage_deleted_idx";
      DROP INDEX IF EXISTS "ChatChannelMember_user_active_idx";
      DROP TRIGGER IF EXISTS chat_member_count_trg ON "ChatChannelMember";
      DROP FUNCTION IF EXISTS chat_member_count();
      ALTER TABLE "ChatChannelMember" DROP CONSTRAINT IF EXISTS "ChatChannelMember_lastReadSeq_nonneg";
    `);
    await q(OLD_FUNCTION_SQL);
    await q(`
      DROP TABLE IF EXISTS "ChatMessage_new" CASCADE;
      DROP TABLE IF EXISTS "ChatMessageIndex";
      ALTER TABLE "ChatMessage" DROP COLUMN IF EXISTS "deletedBy";
      ALTER TABLE "ChatChannel" DROP COLUMN IF EXISTS "deleteEpoch", DROP COLUMN IF EXISTS "activeMemberCount";
    `);
  },
};
