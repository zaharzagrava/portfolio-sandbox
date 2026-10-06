# SD-11 — Product Discussions (Reddit-style posts, nested comments, voting, ranking)

Status: ☑ done (typechecked; specs written, not run) · Phase 3 · Depends on: F-02 (Scylla), F-05, SD-34, SD-28

## Marketplace adaptation
Each product and brand has a **community board**: buyers write posts ("iPhone 17 battery after 3 months", "Is this seller legit?"), nested comment threads, up/down votes, sorted by Hot / Top / New / Best. Hot launches produce 50k-comment threads and vote storms.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Posts & comments in ScyllaDB** (Keyspaces on AWS): `comments_by_post` partition `(post_id, bucket)` clustered by materialised `path` → one sequential read loads a thread in display order | 10/05 #11, D24 |
| **Materialised path** (`0001.0005.0012`, base-36 fixed width) for nested threads; "load more" per branch with paging state | 10/05 #11 |
| **Votes** in Scylla `votes_by_user (user_id, target_id) → value` (one vote per user, changeable) + **delta** applied to counters | 10/05 #11 |
| Vote counters: Redis `HINCRBY` (write-behind, SD-34) flushed every 5 s to Scylla `counter` table / Postgres summary — no row-lock contention on hot posts | 03/04, 03/02 hot rows |
| **Hot ranking** (Reddit formula: `log10(max(|s|,1)) * sign + age/45000`) recomputed on vote deltas → Redis ZSET `board:{productId}:hot` top-N | 10/05 #11 |
| **Wilson score lower bound** for "Best" comments | 10/05 #11 |
| Top (time window) via per-day ZSETs `ZUNIONSTORE` | 10/05 #11 |
| Hot thread first page cached 5 s (SD-34 SWR) | 10/05 #11 |
| Abuse: vote rate limits per user, new-account vote weight, shadow-ban flag | 10/05 #11 |
| XSS-safe user content: store raw markdown, render with sanitiser allowlist; output encoding by context | 05/01 §1 |
| Snowflake-style time-ordered IDs (`timeuuid`) for posts/comments | 10/05 #9, 03/03 §6 |

## Data / storage
- Scylla: `posts_by_board(board_id, bucket, post_id)`, `posts(post_id)`, `comments_by_post(post_id, bucket, path)`, `votes_by_user`, `vote_counts` (counter type).
- Redis: `board:{id}:hot|new` ZSETs, `votes:{targetId}` hash (ups/downs deltas), hot thread cache.
- Postgres: none on the hot path (board ↔ product mapping uses Product read model).

## API
`POST /boards/:productId/posts`, `GET /boards/:productId/posts?sort=hot|top|new&cursor=`, `POST /posts/:id/comments` {parentId}, `GET /posts/:id/comments?sort=best&after=path`, `PUT /votes/:targetId` {value: -1|0|1}.

## Steps
- [x] CQL migrations; `DiscussionsModule` with Scylla repositories (prepared statements, paging state as opaque cursor).
- [x] Path allocator: per-parent child counter (Scylla counter or Redis INCR) → fixed-width base-36 segment.
- [x] Vote service: LWT-free upsert + delta computation (read previous vote from `votes_by_user`), Redis delta, ranking updater.
- [x] Ranking functions (pure, unit-tested: used by posts and comments → shared).
- [x] Flush job (SD-29 cron 5 s) Redis deltas → Scylla counters.
- [x] Sanitised markdown rendering.
- [x] e2e: nested replies come back in path order; flip vote +1 → −1 changes score by −2; 100 parallel votes from distinct users → count exactly 100.

## Scale
- Target: 50k reads/s on hot boards, 10k votes/s, 2k comments/s; threads with 50k comments.
- Hot path: list → Redis ZSET (IDs) → hydrate posts via Scylla multi-get (cached); vote → Scylla upsert + Redis HINCRBY; comment → Scylla insert. Postgres not involved.
- First bottleneck & fix: unbounded partitions for mega-threads → `(post_id, bucket)` buckets of 5k comments; hot vote counters → Redis deltas, flushed.
- Partitioning: Scylla by post_id(+bucket); Redis by board.
- Capacity model: Scylla node ~50k writes/s → 3-node cluster (RF=3) covers 12k writes/s with headroom; Keyspaces on-demand in AWS.
- Proof: k6 vote storm + thread read; thresholds p99 read < 50 ms, vote < 30 ms; invariant: final count == distinct voters.

## FE visualisation (phase 2)
Board page with sort tabs, nested thread with collapse/load-more, optimistic votes.

## Implementation notes (2026-10-01)
- CQL `cql/010_discussions.cql`: `posts_by_board` ((board, yyyymm) partitions, newest first), `posts`, `comments_by_post` ((post, bucket) partitions clustered by **materialized path**), `comment_locator`, `votes_by_user` + `votes_by_target` (denormalized), `vote_counts` (counters). `CassandraModule` now registers a test truncate cleaner.
- `discussions/paths.ts`: coordination-free path segments (base-36 ms + random, fixed width → lexicographic = chronological), subtree ranges; buckets of 5,000 top-level comments (replies live in their root's bucket).
- `ranking.ts`: Reddit hot (log10 net + 45000 s), Wilson lower bound. `content.ts`: markdown → allowlist-sanitized HTML once at write (`nofollow ugc noopener`). Spec `ranking.spec.ts`.
- `DiscussionService`: posts/comments in Scylla only, hot/top via capped Redis ZSETs, new via Scylla month-bucket walk with paging-state cursors, chronological thread (ordered partition reads), "best" thread (Wilson-ranked top-level + first replies per branch via path range), tombstoned deletes.
- `VoteService`: per-(user, target) Redis lock, delta computation (±2 on flip), live score HINCRBY, write-behind deltas → Scylla counters (`discussions.flush-votes` every 5 s, restore on failure, driver retries disabled for counters), exact `recount` from `votes_by_target`, re-ranking.
- Endpoints: `POST|GET /api/boards/:boardId/posts`, `GET /api/posts/:postId`, `GET|POST /api/posts/:postId/comments`, `DELETE /api/comments/:id`, `PUT /api/votes/:targetId`; rate limits `discussion.write` / `discussion.vote`.
- Spec `discussions/discussions.e2e-spec.ts`.
