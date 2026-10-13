-- S28: mark-all watermark per user. Items that arrived at or before `read_all_before` count as read; items that arrive
-- later stay unread whatever their event time. Same retention as the inbox rows.
CREATE TABLE IF NOT EXISTS marketplace.inbox_state (
  user_id uuid PRIMARY KEY,
  read_all_before timestamp
) WITH default_time_to_live = 15552000;

-- S28 delivery timeline: one row per status move of a delivery (the `deliveries` row stays the summary). Detail never
-- holds a body, address or token.
CREATE TABLE IF NOT EXISTS marketplace.delivery_timeline (
  delivery_id text,
  at timestamp,
  status text,
  provider text,
  provider_message_id text,
  detail text,
  failover boolean,
  PRIMARY KEY ((delivery_id), at, status)
) WITH CLUSTERING ORDER BY (at ASC, status ASC)
  AND default_time_to_live = 7776000;   -- 90 days

-- Provider callbacks look a delivery up by the provider's message id for 30 days (was 90).
ALTER TABLE marketplace.deliveries_by_provider_id WITH default_time_to_live = 2592000;

-- Inbox rows keep 180 days (stated again so the retention is part of this change).
ALTER TABLE marketplace.inbox_by_user WITH default_time_to_live = 15552000;
