# Data model: S25 — Product discussions

Stores owned by `community` (D5): ScyllaDB keyspace `marketplace` (migrations in `packages/backend/cql/`, new file `060_discussions_s25.cql`, additive only, III.11) and Redis key prefix `dsc:` (new; the old `score:*`, `post-meta:*`, `board:{…}:top`, `post:{…}:best` keys age out and are no longer read). No PostgreSQL table. The idempotency record is the platform's (`infrastructure/idempotency`). `<id>` columns are `timeuuid` unless stated.

## Durable tables (Scylla)

| Table | Key | Columns | Notes |
|---|---|---|---|
| `posts` (existing) | `post_id` | `board_id text`→ product UUID text, `author_id`, `title`, `body_md`, `body_html`, `created_at`, `deleted`, **+`deleted_by text`, +`shadow boolean`, +`html_version int`** | `body_md` set to null on deletion (raw markdown erased); `comment_buckets` kept, no longer written. |
| `posts_by_board` (existing) | `((board_id, bucket), post_id DESC)` | `author_id`, `title`, **+`shadow boolean`, +`deleted boolean`** | `bucket = yyyymm` of `created_at` (UTC). A delete writes `deleted = true` (list reads skip it). |
| **`board_months`** | `((board_id), bucket DESC)` | – | One row per non-empty month, inserted in the post batch (idempotent). `new` walks it: no horizon. |
| `comments_by_post` (existing) | `((post_id, bucket), path)` | `comment_id`, `parent_id`, `author_id`, `body_md`, `body_html`, `created_at`, `deleted`, **+`deleted_by`, +`shadow`, +`html_version`, +`depth tinyint`, +`root_id`** | Tombstone: `deleted = true`, `deleted_by` set, `body_md`/`body_html`/`author_id` nulled. `path` = time-based segments (`domain/paths.ts`, clock injected). |
| **`top_comments_by_post`** | `((post_id, bucket), path)` | `comment_id`, `shadow`, `deleted` | Roots only: cheap page of top-level comments (R-6). Kept in step with the root row by the same logged batch / LWT delete. |
| `comment_locator` (existing) | `comment_id` | `post_id`, `bucket`, `path`, **+`depth`, +`author_id`, +`parent_id`** | Point lookup for delete, vote target resolution, replies. |
| **`post_buckets`** | `post_id` | `bucket int`, `filled int` | LWT slot allocator for roots (cap = configuration, default 5,000; tests 5). |
| `votes_by_target` (existing) | `((target_id), user_id)` | `value tinyint`, **+`weight tinyint`, +`cast_at timestamp`, +`version int`**, **+`target_type text`** | The vote truth (R-1). Retraction deletes the row (version restarts at 0; a replayed retract is a no-op). Null `weight` (legacy) reads as 1. |
| `votes_by_user` (existing) | – | – | Unused from this release; dropped in a later contract step (C8). |
| `vote_counts` (existing) | `target_id` | `ups counter`, `downs counter`, **+`wups counter`, +`wdowns counter`** | Fed by the write-behind flush (≤ 5 s); rebuilt by reconciliation. |
| **`post_comment_counts`** | `post_id` | `visible counter` | Non-deleted, non-shadow comments (FR-016). Incremented after the batch commits, decremented once after the delete LWT applies. Reconciled. |
| **`comment_reply_counts`** | `comment_id` | `visible counter` | Direct replies, same rule. |
| **`shadow_bans`** | `user_id` | `set_by uuid`, `set_at timestamp` | Row present = banned. Lift deletes the row. Content flagged `shadow` at write time stays flagged (prospective). |
| **`create_claims`** | `((user_id, key_hash))` | `kind text`, `entity_id`, `created_at timestamp`, `fingerprint text` | `INSERT … IF NOT EXISTS USING TTL 90000` before a post/comment batch (R-4). |
| **`recorded_events`** | `((event_id))` | `type`, `version int`, `aggregate_id`, `occurred_at`, `payload text` | Immutable record, written in the creation/deletion batch (TTL 30 days). |
| **`pending_events`** | `((hour_shard), event_id)` | `type`, `payload`, `occurred_at`, `aggregate_id` | Relay work queue; `hour_shard = yyyymmddhh × 8 + hash(aggregate_id) % 8`; TTL 48 h, TWCS, `gc_grace_seconds = 3600`. Row deleted after a successful publish. |
| **`dead_events`** | `((day), event_id)` | `reason`, `payload` | Invalid recorded events (R-3). TTL 14 days. |
| **`recent_targets`**, **`recent_posts`** | `((day), target_id)` / `((day), post_id)` | – | Targets voted / posts commented in the last 48 h (TTL 48 h): the reconciliation worklist. |

Partition bounds (FR-014): posts per `(board, month)`; roots/replies per `(post, bucket)` ≤ 5,000 roots plus their replies (a root's replies are bounded by depth × their rate, and by the 50,000-comment thread claim; `comments_by_post` partitions are read by range, never whole); votes per target (one partition per target, rows ≤ voters; paged when read); `pending_events` per hour-shard.

## Derived state (Redis, every key has a TTL, III.9)

| Key | Type | TTL | Content |
|---|---|---|---|
| `dsc:cnt:{targetId}` | hash | 1 h | `ups`, `downs`, `wups`, `wdowns` (rebuilt from `votes_by_target` on a miss). |
| `dsc:ccnt:{postId}` | hash | 1 h | `comments`, plus `r:{commentId}` reply counts for the post (rebuilt from the count tables, then from rows). |
| `dsc:rank:{boardId}:hot`, `dsc:rank:{boardId}:top:{day\|week\|month\|year\|all}` | zset | 6 h (refreshed on write) | member = `sortableId(postId)`, score = ranking value; trimmed to the cap (default 1,000). |
| `dsc:rank:{postId}:best` | zset | 6 h | member = `sortableId(commentId)` of top-level comments, score = Wilson bound. |
| `dsc:page:{postId}:{sort}` | string (JSON) | 5 s | First thread page, viewer-independent (no `myVote`, no shadow items); deleted by every write to the thread (FR-036). |
| `dsc:anom:{targetId}` / `dsc:anomsent:{targetId}` | zset / string | 15 min / 1 h | Zero-weight vote timestamps; once-per-hour latch. |
| `dsc:pending-counts` | write-behind counter | – | Existing `WriteBehindCounter`, name `discussions-votes` (its own TTL rules). |

## Value rules (pure, `domain/`)

- `PostId`/`CommentId`: time-based UUID (R-5); `sortableId(uuid)` = 32 hex, timestamp first; `compareTimeUuid`.
- Title: trim; 3–300 code points; no U+0000–U+001F, U+007F, U+202A–U+202E, U+2066–U+2069. Post body ≤ 40,000 code points (empty allowed). Comment body 1–10,000 code points after trim.
- Depth: root 0, max 8. `path` segment per level; a reply's path = parent path + `.` + segment.
- Vote: `value ∈ {-1, 0, 1}`; stored `-1|1`; `weight ∈ {0, 1}` fixed at cast time; transition `delta(prev, next) → {dUps, dDowns, dWups, dWdowns}`.
- Hot / Wilson / top window / anomaly: formulas of FR-032–FR-034, FR-053; all take `now` as a parameter.
- Cursor: `base64url(kind | scope | position | hmac)`; kinds `hot|top|new|best|old|replies`, scope = board+sort+window or post or comment; verified before use.

## State transitions

- **Post**: `visible → deleted(by author|moderator)` (one-way; LWT `UPDATE posts SET deleted = true, deleted_by = ? IF deleted = false` — the applied result decides who records the event and decrements nothing). Shadow is a creation-time flag, never changed.
- **Comment**: `visible → tombstone(by author|moderator)` (`UPDATE … SET deleted = true … IF deleted = false` on the comment row and on its `top_comments_by_post` row; the applied result decides who decrements and who records the event). A reply reads its parent (`deleted` → `409 parent_deleted`) before its batch; a delete that commits between that read and the batch leaves the reply under the tombstone, which is one of the two outcomes AS-23 allows (the parent row always exists, so no orphan). Counts follow the committed rows: the reply is counted, the parent's decrement happens once.
- **Vote**: `none ⇄ up ⇄ down` via CAS on `version`.

## Migration order (expand/contract)

1. `060_discussions_s25.cql`: new columns and tables (additive; old code keeps working).
2. Code switches reads/writes to the new layout (this change).
3. Later (not this change): drop `votes_by_user`, `posts.comment_buckets`; backfill of `board_months` and `top_comments_by_post` for old data by a one-shot job `discussions.backfill` (reads `posts_by_board`/`comments_by_post`, idempotent upserts) — scheduled by T-tasks as an expand step because a deployed board has old rows.
