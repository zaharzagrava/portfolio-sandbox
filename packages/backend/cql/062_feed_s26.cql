-- S26 follow graph and home feed (specs/domains/S26-follow-feed/data-model.md). Additive only (expand step): nothing is dropped.

ALTER TABLE marketplace.following_by_user ADD (active boolean, rel_ts bigint);

ALTER TABLE marketplace.feed_items ADD (product_id text, shop_id text, post_id text);

ALTER TABLE marketplace.items_by_author ADD kind text;

-- Newest-first list of whom a buyer follows (keyset on followed_at, account_id).
CREATE TABLE IF NOT EXISTS marketplace.following_by_time (
  user_id uuid,
  followed_at timestamp,
  account_id text,
  PRIMARY KEY ((user_id), followed_at, account_id)
) WITH CLUSTERING ORDER BY (followed_at DESC, account_id ASC);

-- Reservation counter for the following limit (LWT IF n = ?).
CREATE TABLE IF NOT EXISTS marketplace.following_counts (
  user_id uuid PRIMARY KEY,
  n int
);

-- Sticky celebrity status; never deleted by code.
CREATE TABLE IF NOT EXISTS marketplace.celebrity_accounts (
  account_id text PRIMARY KEY,
  since timestamp,
  followers_at_promotion bigint
);

-- One item per (kind, source): INSERT ... IF NOT EXISTS. price_drop claims are written USING TTL 86400.
CREATE TABLE IF NOT EXISTS marketplace.item_claims (
  kind text,
  source_key text,
  item_id timeuuid,
  created_at timestamp,
  PRIMARY KEY ((kind, source_key))
);

-- Community-owned copy of the product fields the feed shows (version-guarded upsert; DELETED is the tombstone).
CREATE TABLE IF NOT EXISTS marketplace.product_copies (
  product_id text PRIMARY KEY,
  shop_id text,
  title text,
  price_minor bigint,
  currency text,
  status text,
  is_sandbox boolean,
  product_version bigint,
  updated_at timestamp
);

-- A post deleted before its creation event arrived (30 days).
CREATE TABLE IF NOT EXISTS marketplace.post_tombstones (
  post_id text PRIMARY KEY,
  deleted_at timestamp
) WITH default_time_to_live = 2592000;

-- Completed fan-out marker (7 days): redelivery of feed.item_published does nothing twice.
CREATE TABLE IF NOT EXISTS marketplace.fanout_done (
  item_id timeuuid PRIMARY KEY,
  done_at timestamp
) WITH default_time_to_live = 604800;

-- Relay work queue written in the item batch; hour_shard = yyyymmddhh * 8 + hash(item_id) % 8 (48 h).
CREATE TABLE IF NOT EXISTS marketplace.pending_announcements (
  hour_shard bigint,
  item_id timeuuid,
  author_id text,
  kind text,
  created_at timestamp,
  PRIMARY KEY ((hour_shard), item_id)
) WITH default_time_to_live = 172800
  AND compaction = {'class': 'TimeWindowCompactionStrategy', 'compaction_window_unit': 'HOURS', 'compaction_window_size': 1};

-- Announcements that could not be published because the row was invalid (14 days).
CREATE TABLE IF NOT EXISTS marketplace.dead_announcements (
  day int,
  item_id timeuuid,
  reason text,
  payload text,
  PRIMARY KEY ((day), item_id)
) WITH default_time_to_live = 1209600;
