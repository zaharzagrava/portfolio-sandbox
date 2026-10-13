-- S25 product discussions (specs/domains/S25-discussions/data-model.md). Additive only (expand step): old code keeps working.

ALTER TABLE marketplace.posts ADD (shadow boolean, deleted_by text, html_version int);

ALTER TABLE marketplace.posts_by_board ADD (shadow boolean, deleted boolean);

ALTER TABLE marketplace.comments_by_post ADD (shadow boolean, deleted_by text, html_version int, depth tinyint, root_id timeuuid);

ALTER TABLE marketplace.comment_locator ADD (depth tinyint, author_id uuid, parent_id timeuuid);

ALTER TABLE marketplace.votes_by_target ADD (weight tinyint, cast_at timestamp, version int, target_type text);

ALTER TABLE marketplace.vote_counts ADD (wups counter, wdowns counter);

-- One row per non-empty month of a board: the `new` list walks it, so there is no history horizon.
CREATE TABLE IF NOT EXISTS marketplace.board_months (
  board_id text,
  bucket int,
  PRIMARY KEY ((board_id), bucket)
) WITH CLUSTERING ORDER BY (bucket DESC);

-- Roots only: a cheap page of top-level comments (a thread of 50,000 never reads its replies to list its roots).
CREATE TABLE IF NOT EXISTS marketplace.top_comments_by_post (
  post_id timeuuid,
  bucket int,
  path text,
  comment_id timeuuid,
  shadow boolean,
  deleted boolean,
  author_id uuid,
  PRIMARY KEY ((post_id, bucket), path)
);

-- LWT slot allocator for top-level comments (partition size is configuration).
CREATE TABLE IF NOT EXISTS marketplace.post_buckets (
  post_id timeuuid PRIMARY KEY,
  bucket int,
  filled int
);

CREATE TABLE IF NOT EXISTS marketplace.post_comment_counts (
  post_id timeuuid PRIMARY KEY,
  visible counter
);

CREATE TABLE IF NOT EXISTS marketplace.comment_reply_counts (
  comment_id timeuuid PRIMARY KEY,
  visible counter
);

CREATE TABLE IF NOT EXISTS marketplace.shadow_bans (
  user_id uuid PRIMARY KEY,
  set_by uuid,
  set_at timestamp
);

-- Creation claim: INSERT ... IF NOT EXISTS USING TTL before a post/comment batch (crash window of the platform record).
CREATE TABLE IF NOT EXISTS marketplace.create_claims (
  user_id uuid,
  key_hash text,
  kind text,
  entity_id timeuuid,
  fingerprint text,
  created_at timestamp,
  PRIMARY KEY ((user_id, key_hash))
);

CREATE TABLE IF NOT EXISTS marketplace.recorded_events (
  event_id uuid PRIMARY KEY,
  type text,
  version int,
  aggregate_id text,
  occurred_at timestamp,
  payload text
) WITH default_time_to_live = 2592000;

CREATE TABLE IF NOT EXISTS marketplace.pending_events (
  hour_shard bigint,
  event_id uuid,
  type text,
  aggregate_id text,
  occurred_at timestamp,
  payload text,
  PRIMARY KEY ((hour_shard), event_id)
) WITH default_time_to_live = 172800
  AND gc_grace_seconds = 3600
  AND compaction = {'class': 'TimeWindowCompactionStrategy', 'compaction_window_unit': 'HOURS', 'compaction_window_size': 1};

CREATE TABLE IF NOT EXISTS marketplace.dead_events (
  day int,
  event_id uuid,
  reason text,
  payload text,
  PRIMARY KEY ((day), event_id)
) WITH default_time_to_live = 1209600;

-- Reconciliation worklists: targets voted / posts commented in the last 48 hours.
CREATE TABLE IF NOT EXISTS marketplace.recent_targets (
  day int,
  target_id timeuuid,
  PRIMARY KEY ((day), target_id)
) WITH default_time_to_live = 172800;

CREATE TABLE IF NOT EXISTS marketplace.recent_posts (
  day int,
  post_id timeuuid,
  PRIMARY KEY ((day), post_id)
) WITH default_time_to_live = 172800;
