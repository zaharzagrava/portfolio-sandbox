-- SD-17 in-app inbox: newest first, one partition per (user, month) so a chatty account never grows an unbounded partition.
CREATE TABLE IF NOT EXISTS marketplace.inbox_by_user (
  user_id uuid,
  bucket int,              -- yyyymm
  notif_id timeuuid,
  type text,
  category text,
  title text,
  body text,
  link text,
  read boolean,
  PRIMARY KEY ((user_id, bucket), notif_id)
) WITH CLUSTERING ORDER BY (notif_id DESC)
  AND default_time_to_live = 15552000;   -- 180 days

-- Delivery log keyed by our delivery id (status timeline for support/debugging).
CREATE TABLE IF NOT EXISTS marketplace.deliveries (
  delivery_id text PRIMARY KEY,
  user_id uuid,
  channel text,
  type text,
  provider text,
  provider_message_id text,
  status text,             -- queued | sent | delivered | bounced | complained | failed | suppressed | capped
  detail text,
  updated_at timestamp
) WITH default_time_to_live = 7776000;   -- 90 days

-- Provider callbacks only know THEIR message id.
CREATE TABLE IF NOT EXISTS marketplace.deliveries_by_provider_id (
  provider text,
  provider_message_id text,
  delivery_id text,
  PRIMARY KEY ((provider, provider_message_id))
) WITH default_time_to_live = 7776000;
