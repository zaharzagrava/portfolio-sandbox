-- SD-09 follow feed. Account ids are text: 'shop:<uuid>' or 'user:<uuid>'.

-- Who follows X (fan-out pages through this) and whom does U follow (pull side) - written together.
CREATE TABLE IF NOT EXISTS marketplace.followers_by_account (
  account_id text,
  follower_id uuid,
  followed_at timestamp,
  PRIMARY KEY ((account_id), follower_id)
);

CREATE TABLE IF NOT EXISTS marketplace.following_by_user (
  user_id uuid,
  account_id text,
  followed_at timestamp,
  PRIMARY KEY ((user_id), account_id)
);

CREATE TABLE IF NOT EXISTS marketplace.follower_counts (
  account_id text PRIMARY KEY,
  followers counter
);

CREATE TABLE IF NOT EXISTS marketplace.feed_items (
  item_id timeuuid PRIMARY KEY,
  author_id text,
  kind text,
  title text,
  payload text,
  created_at timestamp
);

-- Per-author history by month: the pull side (celebrities, timeline rebuild for returning users).
CREATE TABLE IF NOT EXISTS marketplace.items_by_author (
  author_id text,
  month int,
  item_id timeuuid,
  PRIMARY KEY ((author_id, month), item_id)
) WITH CLUSTERING ORDER BY (item_id DESC);
