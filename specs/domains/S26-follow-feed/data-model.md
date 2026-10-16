# Data model: S26 — Follow graph and home feed

Stores owned by `community` (D5: no PostgreSQL table): ScyllaDB keyspace `marketplace` (new migration `packages/backend/cql/062_feed_s26.cql`, additive only, III.11: no column dropped, no table dropped) and Redis key prefix `fd:` (new; every key has a TTL, III.9). The old unprefixed keys (`tl:`, `celeb:`, `following:`, `followers:`, `feed:celebrities`, `active:`, `feed:product-published:`) are no longer written; they expire or are deleted by a one-off code path in the reconciliation job's first run (`UNLINK` by explicit key, never `KEYS`/`SCAN` on the hot instance), then the code is removed.

## Durable tables (Scylla)

| Table | Key | Columns | Notes |
|---|---|---|---|
| `following_by_user` (existing) | `((user_id), account_id)` | `followed_at timestamp`, **+`active boolean`**, **+`rel_ts bigint`** | Truth of a relation (R-1). `active` null = legacy row, read as true. Unfollow keeps the row with `active = false`. |
| **`following_by_time`** | `((user_id), followed_at DESC, account_id)` | – | The newest-first list of whom a buyer follows (keyset `(followed_at, account_id)`). Written/deleted with `USING TIMESTAMP rel_ts`. |
| `followers_by_account` (existing) | `((account_id), follower_id)` | `followed_at timestamp` | Who follows an account; fan-out pages by `token(follower_id)`/`follower_id` cursor. Written/deleted with `USING TIMESTAMP rel_ts`. |
| `follower_counts` (existing) | `account_id` | `followers counter` | Moved only by the applied conditional write; reads clamp at 0; reconciled. |
| **`following_counts`** | `user_id` | `n int` | Reservation counter for the limit (R-2); LWT `IF n = ?`. |
| **`celebrity_accounts`** | `account_id` | `since timestamp`, `followers_at_promotion bigint` | Sticky (R-3). Never deleted by code. |
| `feed_items` (existing) | `item_id` (timeuuid) | `author_id`, `kind`, `title`, `payload text (JSON)`, `created_at`, **+`product_id text`**, **+`shop_id text`**, **+`post_id text`** | Written once per `(kind, source)` with `USING TTL 7776000` (90 days, FR-028). `product_id`/`shop_id`/`post_id` are the hydration keys (null when not applicable). `payload` is typed per kind (AS-43). |
| `items_by_author` (existing) | `((author_id, month), item_id DESC)` | `kind` | History per author for pull/rebuild/celebrity recents; TTL 90 days; `month` = UTC `yyyymm`. |
| **`item_claims`** | `((kind, source_key))` | `item_id timeuuid`, `created_at` | `INSERT … IF NOT EXISTS` (R-4). `price_drop` claims `USING TTL 86400`; the others have no TTL (one row per source). |
| **`product_copies`** | `product_id` | `shop_id`, `title`, `price_minor bigint`, `currency`, `status text` (`ACTIVE`/`ARCHIVED`/`DELETED`), `is_sandbox boolean`, `product_version bigint`, `updated_at` | Version-guarded upsert (R-6). `DELETED` is the tombstone state. |
| **`post_tombstones`** | `post_id` | `deleted_at` | TTL 30 days (post deleted before created). |
| **`fanout_done`** | `item_id` | `done_at timestamp` | Completed fan-out marker, TTL 7 days (AS-22). |
| **`pending_announcements`** | `((hour_shard), item_id)` | `author_id`, `kind`, `created_at` | Relay work queue, `hour_shard = yyyymmddhh * 8 + hash(item_id) % 8`; TTL 48 h; TWCS; written in the item batch. Deleted after a successful publish. |
| **`dead_announcements`** | `((day), item_id)` | `reason`, `payload` | Invalid recorded announcements; TTL 14 days. |

`feed.item_published` payload fields come from the `feed_items` row (`itemId`, `authorId`, `kind`, `createdAt`), so the relay needs no extra payload column.

## Redis keys (derived, rebuildable, all with a TTL; prefix `fd:`)

| Key | Type | TTL | Content |
|---|---|---|---|
| `fd:act:{userId}` | string | 7 d, slides on each feed read | Active marker. |
| `fd:tl:{userId}` | ZSET | 7 d from last write | Members = `sortableId(itemId)`, score = ms; trimmed to the window (800). |
| `fd:tlc:{userId}` | string | 7 d | "Timeline complete": set only when a rebuild read every author. Deleted by follow/unfollow. |
| `fd:rb:{userId}` | string | 10 s | Single-flight rebuild lock (`SET NX PX`). |
| `fd:cel:{authorId}` | ZSET | 24 h from last item | The 200 newest items of a celebrity. |
| `fd:iscel:{accountId}` | string `0`/`1` | 1 h | Read-through cache of `celebrity_accounts` membership (one key per account, never a global set). Only `1` is trusted for pushing decisions after a promotion; a miss reads the table. |
| `fd:cf:{userId}` | string (JSON list) | 1 h | Followed celebrities of a user (cache of the intersection). |

## State transitions

- **Relation**: `absent → active (follow)`, `active → inactive (unfollow)`, `inactive → active (re-follow)`; each transition strictly raises `rel_ts`; repeats are no-ops (`204`).
- **Item**: `stored → announced (pending row deleted after publish) → fanned out (fanout_done)`; visibility at read: visible unless hidden by hydration rules (never stored).
- **Product copy**: version rises monotonically; `ACTIVE ⇄ ARCHIVED`, any → `DELETED` (final).
- **Celebrity**: `normal → celebrity` (sticky).
- **Timeline**: `absent/partial → complete (tlc set) → partial (follow/unfollow clears tlc) → complete`.
