-- SD-11 product discussions (D24: write-heavy, read-by-key, no relational invariants → ScyllaDB / Keyspaces).

-- Board listing "new": one partition per (board, month) so a busy board's partition never grows unbounded.
CREATE TABLE IF NOT EXISTS marketplace.posts_by_board (
  board_id text,
  bucket int,              -- yyyymm
  post_id timeuuid,
  author_id uuid,
  title text,
  PRIMARY KEY ((board_id, bucket), post_id)
) WITH CLUSTERING ORDER BY (post_id DESC);

CREATE TABLE IF NOT EXISTS marketplace.posts (
  post_id timeuuid PRIMARY KEY,
  board_id text,
  author_id uuid,
  title text,
  body_md text,
  body_html text,
  created_at timestamp,
  deleted boolean,
  comment_buckets int      -- highest comment bucket in use (+1); readers scan buckets 0..n-1
);

-- A thread in display order with ONE sequential partition read: clustering by materialized path
-- ("k3x9a1b2c.k3x9a7f0d" = reply to the first). Buckets of top-level subtrees cap partition size for 50k-comment threads.
CREATE TABLE IF NOT EXISTS marketplace.comments_by_post (
  post_id timeuuid,
  bucket int,
  path text,
  comment_id timeuuid,
  parent_id timeuuid,
  author_id uuid,
  body_md text,
  body_html text,
  created_at timestamp,
  deleted boolean,
  PRIMARY KEY ((post_id, bucket), path)
);

CREATE TABLE IF NOT EXISTS marketplace.comment_locator (
  comment_id timeuuid PRIMARY KEY,
  post_id timeuuid,
  bucket int,
  path text
);

-- One vote per user per target, changeable; two denormalized views (by user for "my vote", by target for exact recounts).
CREATE TABLE IF NOT EXISTS marketplace.votes_by_user (
  user_id uuid,
  target_id timeuuid,
  value tinyint,
  PRIMARY KEY ((user_id), target_id)
);

CREATE TABLE IF NOT EXISTS marketplace.votes_by_target (
  target_id timeuuid,
  user_id uuid,
  value tinyint,
  PRIMARY KEY ((target_id), user_id)
);

-- Durable counters, fed by the write-behind flush (counter updates are not idempotent → periodic exact recount for hot targets).
CREATE TABLE IF NOT EXISTS marketplace.vote_counts (
  target_id timeuuid PRIMARY KEY,
  ups counter,
  downs counter
);
