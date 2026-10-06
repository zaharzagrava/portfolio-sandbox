# SD-09 — Follow Feed (Twitter-style home timeline of shops & brands)

Status: ☑ done (typechecked; specs written, not run) · Phase 3 · Depends on: F-02 (Scylla), F-05, SD-29, SD-11 (posts)

## Marketplace adaptation
Buyers **follow shops, brands and other buyers**. The home feed shows new products, price drops, restocks, drop announcements, shop posts and discussions from followed accounts. Big brands ("Apple", 20M followers) are the celebrity problem.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Hybrid fan-out**: fan-out-on-write for normal accounts (followers < 50k) into per-user timelines; fan-out-on-read for celebrity shops merged at read time | 10/05 #9 |
| Timelines: **Redis list** per active user (`LPUSH` + `LTRIM 800`) + **Scylla `timeline_by_user`** as durable store for inactive users / rebuild | 10/05 #9, D24 |
| Followers in Scylla: `followers_by_account(account_id, follower_id)` and `following_by_user` (two tables, written together, denormalised) | D24 |
| Fan-out workers: Kafka `feed.items` (key = authorId) → fan-out consumer paging followers (1k per page), batched pipelined writes; backpressure via pause/resume | 06/01 §8 |
| Only **active users** (seen in 7 days) get pushed timelines; others rebuilt on return | 10/05 #9 |
| Hydration: timeline holds IDs → batch multi-get of items (DataLoader-style) from cache; deleted/hidden items filtered at hydration | 10/05 #9 |
| Snowflake IDs → cursor pagination (`max_id`) for free | 10/05 #9 |
| Ranking hook (chronological + boost for followed brands' drops) | — |

## Data / storage
- Scylla: `followers_by_account`, `following_by_user`, `feed_items(item_id)`, `timeline_by_user(user_id, bucket_month, item_id DESC)`.
- Redis: `tl:{userId}` lists, `celebrity:{accountId}:recent` ZSET, `active_users` HyperLogLog/bitmap.
- Kafka: `feed.items` from F-05 events (product.created, price.dropped, drop.announced, post.created).

## Steps
- [x] CQL tables; follow/unfollow endpoints.
- [x] Feed item producer: projector mapping domain events → feed items.
- [x] Fan-out consumer (celebrity threshold config, active-user check, pipelined LPUSH/LTRIM + Scylla batch per partition).
- [x] Timeline read: Redis → merge celebrity recents (k-way merge by Snowflake ID) → hydrate.
- [x] Rebuild-on-return for inactive users.
- [x] e2e: follow normal shop → its new product appears in timeline after fan-out (waitFor); follow celebrity → item merged at read; unfollow hides.

## Scale
- Target: 50M DAU, timeline reads 100k RPS, 2k feed items/s, average 300 followers, celebrities 20M.
- Hot path: read → 1 Redis LRANGE + celebrity ZSETs + cached hydration. Write → Kafka; fan-out async.
- First bottleneck & fix: celebrity fan-out write amplification → pull model above threshold; Redis memory → only active users (800 IDs × 8 B × 50M = 320 GB → keep 200 IDs for most, 800 for power users; Redis Cluster ~10 shards).
- Partitioning: Kafka by authorId; Scylla by user_id(+month); Redis by userId.
- Capacity model: 2k items/s × 300 followers = 600k timeline inserts/s → pipelined Redis (≈ 10 shards × 100k ops/s) + Scylla async 600k writes/s → ~12-node cluster; documented that pushing only to active users (~30%) cuts it to ~200k/s.
- Proof: k6 timeline read at 1/2/4 instances; fan-out lag p99 < 5 s for 10k-follower author.

## FE visualisation (phase 2)
Infinite home feed, follow buttons.

## Implementation notes (2026-10-01)
- CQL `cql/020_feed.cql`: `followers_by_account` / `following_by_user` (denormalized pair), `follower_counts` (counter), `feed_items`, `items_by_author` ((author, month), newest first). **Change vs plan:** no durable per-user `timeline_by_user` table — returning users are rebuilt by *pull* from `items_by_author` (k-way merge), which removes the biggest write amplification (writing every item into every follower's Scylla partition).
- `feed/merge.ts`: binary-heap k-way merge newest-first with cursor + dedupe (genuinely needed: own timeline ⊕ N celebrities; rebuild over all followed authors). Spec `merge.spec.ts`.
- `FeedPublisher`: item stored once + `feed.events` keyed by author. `FeedFanoutConsumer` (apps/projector): pages followers 1,000 at a time, one pipelined EXISTS + one pipelined LPUSH/LTRIM per page, **active users only**; celebrities (≥ 10k followers) → capped ZSET, never fanned out. `FeedService`: follow/unfollow (+ celebrity flag), timeline = Redis list ⊕ followed celebrities' ZSETs, hydration filters unfollowed authors, rebuild-on-return, active marker (7 days). `ProductFeedProjector`: first sighting of a shop product → `new_product` item; discussions (SD-11) publish `post` items for the author's followers.
- Endpoints: `GET /api/feed?before=`, `POST|DELETE /api/follow/:accountId` (`shop:<uuid>` / `user:<uuid>`), `GET /api/me/following`.
- Spec `feed/feed.e2e-spec.ts`.
