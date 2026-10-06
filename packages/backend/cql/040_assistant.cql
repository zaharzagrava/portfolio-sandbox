-- SD-42 shopping assistant. Conversations listed per user (newest first); the user id in the key doubles as the ownership check.
-- `summary` + `compacted_upto`: client-side "simple compaction" - once a conversation is too long, everything up to
-- `compacted_upto` is replaced by `summary` and never replayed again (no keep-tail: replayed thinking blocks must keep their exact prefix).
CREATE TABLE IF NOT EXISTS marketplace.assistant_conversations_by_user (
  user_id uuid,
  conversation_id timeuuid,
  title text,
  summary text,
  compacted_upto timeuuid,
  updated_at timestamp,
  PRIMARY KEY (user_id, conversation_id)
) WITH CLUSTERING ORDER BY (conversation_id DESC)
  AND default_time_to_live = 7776000;   -- 90 days

-- Append-only transcript: one row per API message (user text, assistant content incl. thinking blocks, tool results),
-- stored verbatim as JSON so the next request replays byte-identical history (prompt cache + preserved thinking).
-- Bounded partition: turns per conversation are capped by the service (MAX_MESSAGES).
CREATE TABLE IF NOT EXISTS marketplace.assistant_messages_by_conversation (
  conversation_id timeuuid,
  message_id timeuuid,
  turn_id timeuuid,
  role text,
  content text,
  PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id ASC)
  AND default_time_to_live = 7776000;
