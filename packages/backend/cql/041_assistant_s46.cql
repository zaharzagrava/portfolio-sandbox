-- S46 shopping assistant (additive; data-model.md).
-- `message_count` is maintained with the turn batch and replaces count(*); NULL = not yet backfilled (lazy backfill on first send).
ALTER TABLE marketplace.assistant_conversations_by_user ADD message_count int;

-- The transcript moves to a table whose partition carries the owner: every lookup is (user_id, conversation_id), so a foreign
-- conversation id is a plain miss (G2). The old table keyed by conversation_id alone is no longer read or written
-- (pre-S46 chats were an unreleased scaffold; its rows expire with the 90-day TTL).
CREATE TABLE IF NOT EXISTS marketplace.assistant_messages_by_user_conversation (
  user_id uuid,
  conversation_id timeuuid,
  message_id timeuuid,
  turn_id timeuuid,
  role text,
  content text,
  visible_text text,
  tool_names list<text>,
  PRIMARY KEY ((user_id, conversation_id), message_id)
) WITH CLUSTERING ORDER BY (message_id ASC)
  AND default_time_to_live = 7776000;
