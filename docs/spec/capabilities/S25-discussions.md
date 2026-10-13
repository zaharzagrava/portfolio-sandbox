---
id: S25
title: Product discussions (posts, nested comments, votes, ranking, abuse controls, safe markdown)
kind: capability
status: draft
depends_on: [S01, S05, S28, S50, S53, S54]
concepts: [problem-json-errors, rate-limit-policy, idempotency-key, cache-layers, projection-and-replay]
models: []
scope:
  - packages/backend/libs/domains/community/api/discussions*.ts
  - packages/backend/libs/domains/community/api/moderation.controller.ts
  - packages/backend/libs/domains/community/application/post.service.ts
  - packages/backend/libs/domains/community/application/comment.service.ts
  - packages/backend/libs/domains/community/application/vote.service.ts
  - packages/backend/libs/domains/community/application/board-query.service.ts
  - packages/backend/libs/domains/community/application/ranking.service.ts
  - packages/backend/libs/domains/community/application/counts.service.ts
  - packages/backend/libs/domains/community/application/view.service.ts
  - packages/backend/libs/domains/community/application/moderation.service.ts
  - packages/backend/libs/domains/community/application/reconcile.service.ts
  - packages/backend/libs/domains/community/application/event-relay.service.ts
  - packages/backend/libs/domains/community/application/backfill.service.ts
  - packages/backend/libs/domains/community/application/discussion-*.ts
  - packages/backend/libs/domains/community/domain/ids.ts
  - packages/backend/libs/domains/community/domain/paths.ts
  - packages/backend/libs/domains/community/domain/cursor.ts
  - packages/backend/libs/domains/community/domain/content.ts
  - packages/backend/libs/domains/community/domain/ranking.ts
  - packages/backend/libs/domains/community/domain/top-window.ts
  - packages/backend/libs/domains/community/domain/vote-*.ts
  - packages/backend/libs/domains/community/domain/anomaly.ts
  - packages/backend/libs/domains/community/domain/discussion-*.ts
  - packages/backend/libs/domains/community/domain/ports.ts
  - packages/backend/libs/domains/community/infra/scylla-*.ts
  - packages/backend/libs/domains/community/infra/redis-*.ts
  - packages/backend/libs/domains/community/infra/discussions.jobs.ts
  - packages/backend/libs/domains/community/discussions*.ts
  - packages/contracts/src/community/**
---
# S25 - Product discussions (posts, nested comments, votes, ranking, abuse controls, safe markdown)
## Purpose
Every product has one discussion board, addressed by the product's ID. Signed-in buyers start discussions (a plain-text title and a markdown body), answer them in nested comments, and vote posts and comments up or down. Boards list by hot, top (with a time window) and new; threads list by best, new and old. Readers are anonymous-friendly. Everything a user writes is rendered through an allow-list and re-checked on read. Counts are exact, rankings are rebuildable caches, and new-account or shadow-banned votes do not steer rankings. Durable data lives in ScyllaDB, fast derived data in Redis, and lifecycle events reach the feed and notifications through a recorded-then-relayed path.

## Entry points
- `POST /api/boards/:productId/posts`, `GET /api/boards/:productId/posts`, `GET /api/posts/:postId`, `DELETE /api/posts/:postId`, `POST /api/posts/:postId/comments`, `GET /api/posts/:postId/comments`, `GET /api/comments/:commentId/replies`, `DELETE /api/comments/:commentId`, `PUT /api/votes/:targetId`. [code: packages/backend/libs/domains/community/api/discussions.controller.ts#DiscussionsController]
- `PUT /api/moderation/shadow-bans/:userId`, `DELETE /api/moderation/shadow-bans/:userId`: `ADMIN` and `MODERATOR` only. [code: packages/backend/libs/domains/community/api/moderation.controller.ts#ModerationController]
- `DiscussionQueryService.getPostsByIds`: the batch the feed hydrates with. [code: packages/backend/libs/domains/community/application/discussion-query.service.ts#DiscussionQueryService]
- Topic `discussion.events`: `discussion.post_created`, `discussion.post_deleted`, `discussion.comment_created`, `discussion.comment_deleted`, `discussion.vote_anomaly_detected`. [code: packages/backend/libs/domains/community/domain/discussion-events.ts#DiscussionPostCreated]
- Jobs `discussions.flush-votes`, `discussions.relay-events`, `discussions.relay-sweep`, `discussions.reconcile`, `discussions.recount`, `discussions.backfill`. [code: packages/backend/libs/domains/community/infra/discussions.jobs.ts#DiscussionsJobs]

## Rules
- **S25.R-01** A post MUST be created only on the board of an `ACTIVE` product (`404` `board_not_found` for an unknown product, `409` `board_closed` for an archived one, `400` for a board id that is not a UUID), and a post and its raw markdown, its rendition, its index rows and its `discussion.post_created` event MUST be stored by one batch. [proof: S25 AS-01, S25 AS-02] [code: packages/backend/libs/domains/community/application/post.service.ts#PostService]
- **S25.R-02** Post and comment IDs MUST be time-based UUIDs whose embedded time is `createdAt`, unique under concurrent creation, so that ordering by ID is ordering by creation. [proof: S25 AS-19, S25 AS-55] [code: packages/backend/libs/domains/community/domain/ids.ts#TimeIdGenerator]
- **S25.R-03** A title MUST be 3 to 300 code points after trimming, without control or bidirectional-override characters; a post body at most 40,000 code points (empty allowed); a comment body 1 to 10,000 after trimming; an unknown field MUST be refused (`400` `validation_failed`, nothing stored). [proof: S25 AS-03, S25 AS-16] [code: packages/backend/libs/domains/community/domain/content.ts#normalizeTitle]
- **S25.R-04** Every state-changing route MUST answer `401` problem+json without credentials. [proof: S25 AS-04] [code: packages/backend/libs/domains/community/api/discussions.controller.ts#DiscussionsController]
- **S25.R-05** Creating a post or comment MUST be limited to 10 writes a minute per user (`429` `rate_limited` with `Retry-After`, `RateLimit` and `RateLimit-Policy`; `503` `rate_limiter_unavailable` when the limiter store is down), and voting to 60 a minute. [proof: S25 AS-05, S25 AS-31] [code: packages/backend/libs/domains/community/rate-limit-policies.ts#communityRatePolicies]
- **S25.R-06** Creating a post or comment MUST need an `Idempotency-Key`: a replay returns the stored answer and creates nothing, a reused key with another body answers `422`, a request in flight answers `409`, a missing key answers `422`, the scope is the user and the key lives 24 hours; a creation claim in the store makes a retry after a crash reuse the same entity. [proof: S25 AS-06, S25 AS-17, S25 AS-52] [code: packages/backend/libs/domains/community/infra/scylla-claim.store.ts#ScyllaClaimStore]
- **S25.R-07** A post or comment event MUST be recorded in the same batch as the write and relayed at least once with a stable `eventId`; shadow content records none; a recorded event that is not a valid envelope MUST be dead-lettered with no other effect. [proof: S25 AS-07] [code: packages/backend/libs/domains/community/application/event-relay.service.ts#EventRelayService]
- **S25.R-08** User markdown MUST be rendered to only the tags `p, br, strong, em, del, code, pre, blockquote, ul, ol, li, a, h3, h4` (levels 1, 2, 5 and 6 become `h4`), links MUST be absolute `http`, `https` or `mailto` with `rel="nofollow ugc noopener noreferrer"` and `target="_blank"`, and images, raw HTML, comments, styles and handlers MUST be dropped. [proof: S25 AS-08] [code: packages/backend/libs/domains/community/domain/content.ts#renderUserMarkdown]
- **S25.R-09** No payload of the XSS corpus MUST produce an executable construct in a response or a later read, and the stored raw markdown MUST be exactly what was sent. [proof: S25 AS-09] [code: packages/backend/libs/domains/community/domain/content.ts#renderUserMarkdown]
- **S25.R-10** A rendition written under an older policy version MUST NOT be served: the item is re-rendered from the raw markdown and the stored copy is refreshed lazily. [proof: S25 AS-10] [code: packages/backend/libs/domains/community/application/view.service.ts#ViewService]
- **S25.R-11** A title MUST come back byte for byte as JSON text, responses MUST be `application/json` with `X-Content-Type-Options: nosniff`, and only `bodyHtml` carries server markup. [proof: S25 AS-11]
- **S25.R-12** A body nesting quotes or lists deeper than 20 levels MUST be refused with `400` (`markdown_too_complex`) before it is parsed, and a normal maximum-size body MUST render without a stall. [proof: S25 AS-12] [code: packages/backend/libs/domains/community/domain/content.ts#assertMarkdownComplexity]
- **S25.R-13** Comments MUST nest to depth 8 (top level 0): a parent of another post or an unknown parent is `404` `parent_not_found`, a deleted parent `409` `parent_deleted`, a parent at depth 8 `422` `max_depth_exceeded`. [proof: S25 AS-15] [code: packages/backend/libs/domains/community/application/comment.service.ts#CommentService]
- **S25.R-14** A comment MUST be refused on an unknown or deleted post (`404` `post_not_found`) and on a closed board (`409` `board_closed`). [proof: S25 AS-16] [code: packages/backend/libs/domains/community/application/comment.service.ts#CommentService]
- **S25.R-15** A thread MUST be paged by top-level comment, each carrying its first 5 descendants in thread order and a flag for more, and a read MUST touch a bounded number of rows whatever the thread size: top-level comments live in partitions of at most 5,000 and a reply is stored with its root. [proof: S25 AS-14, S25 AS-18] [code: packages/backend/libs/domains/community/infra/scylla-comment.store.ts#ScyllaCommentStore]
- **S25.R-16** Further descendants of one branch MUST load through `GET /api/comments/:commentId/replies` with an opaque cursor; a malformed, tampered or foreign cursor MUST answer `400` `invalid_cursor`, an unknown comment `404`. [proof: S25 AS-20] [code: packages/backend/libs/domains/community/domain/cursor.ts#createCursorCodec]
- **S25.R-17** Deleting a comment MUST leave a tombstone in its position (author, text and raw markdown erased, replies kept), decrement the counts exactly once, record one event, and be idempotent; the author and `ADMIN` or `MODERATOR` may delete, no other role (a shop seller included). [proof: S25 AS-21, S25 AS-22] [code: packages/backend/libs/domains/community/application/comment.service.ts#CommentService]
- **S25.R-18** A reply racing with the delete of its parent MUST end either stored under the tombstone or refused with `409`, never orphaned, and `commentCount` MUST equal the number of non-deleted comments. [proof: S25 AS-23] [code: packages/backend/libs/domains/community/infra/scylla-comment.store.ts#ScyllaCommentStore]
- **S25.R-19** A user MUST have at most one vote per target, changed by compare-and-set; vote, flip and retract MUST move the counts by the committed difference, and a replay MUST answer the same complete `{targetId, targetType, ups, downs, score, myVote}`. [proof: S25 AS-24, S25 AS-25] [code: packages/backend/libs/domains/community/application/vote.service.ts#VoteService]
- **S25.R-20** The target type MUST be resolved by the server: an unknown target is `404` `target_not_found`, a deleted comment `409` `target_deleted`, a deleted post `404`, one's own content `422` `self_vote_not_allowed`; a malformed body (including a client `targetType`) is `400`. [proof: S25 AS-26, S25 AS-27, S25 AS-28] [code: packages/backend/libs/domains/community/application/vote.service.ts#VoteService]
- **S25.R-21** 100 concurrent voters MUST count exactly 100 in the store and in the answer, also after the cache is flushed; concurrent votes of one user MUST answer `200` or `409` `vote_in_progress` with `Retry-After` and leave one record that the counts equal. [proof: S25 AS-29, S25 AS-30] [code: packages/backend/libs/domains/community/infra/scylla-vote.store.ts#ScyllaVoteStore]
- **S25.R-22** `myVote` MUST be `-1`, `0` or `1` for a signed-in reader and `null` for an anonymous one, on posts, lists and threads. [proof: S25 AS-32] [code: packages/backend/libs/domains/community/application/view.service.ts#ViewService]
- **S25.R-23** `hot` MUST rank by `sign(net) x log10(max(|net|, 1)) + (createdAtSeconds - E) / 45000` of the weighted votes (ties by newer post id first), `top` by weighted net inside its window (inclusive start, ties by newer id), `best` by the Wilson lower bound (ties older first), and every list MUST be keyset-paged with an opaque cursor. [proof: S25 AS-33, S25 AS-34, S25 AS-35, S25 AS-36, S25 AS-42] [code: packages/backend/libs/domains/community/domain/ranking.ts#hotScore]
- **S25.R-24** `new` MUST reach every post however old, through the board's non-empty months. [proof: S25 AS-37] [code: packages/backend/libs/domains/community/application/board-query.service.ts#BoardQueryService]
- **S25.R-25** `hot` and `top` MUST consider the best-ranked posts up to the cap (default 1,000) and end there. [proof: S25 AS-38] [code: packages/backend/libs/domains/community/infra/redis-ranking.cache.ts#RedisRankingCache]
- **S25.R-26** An invalid `sort`, `window`, `limit` or `cursor` MUST be `400` and never fall back silently; defaults are `sort=hot`, `limit=25`. [proof: S25 AS-39] [code: packages/backend/libs/domains/community/api/discussions.controller.ts#DiscussionsController]
- **S25.R-27** Reads MUST NOT consult the catalog: an unknown or empty board is an empty page, a deleted post is absent from every list and `GET` of it is `404` (a moderator may still read it). [proof: S25 AS-40, S25 AS-41, S25 AS-47] [code: packages/backend/libs/domains/community/application/post.service.ts#PostService]
- **S25.R-28** The first page of a thread MAY be cached for 5 seconds as a viewer-independent snapshot; every write to the thread MUST drop it; votes may lag by at most 5 seconds; the snapshot MUST hold no `myVote`. [proof: S25 AS-43] [code: packages/backend/libs/domains/community/application/comment.service.ts#CommentService]
- **S25.R-29** A vote's ranking weight MUST be fixed at cast time (0 for an account younger than 24 hours, a shadow-banned voter or an unresolved account, else 1) and replaced or removed with the vote, while displayed counts use raw votes. [proof: S25 AS-44, S25 AS-45] [code: packages/backend/libs/domains/community/domain/vote-weight.ts#voteWeight]
- **S25.R-30** A shadow ban set by `ADMIN` or `MODERATOR` MUST make content created from then on invisible to every reader but its author (lists, threads, counts, rankings, by-ID reads), record no events and zero the user's vote weight; lifting it MUST show only content created afterwards; both calls are idempotent and answer `404` `user_not_found` for an unknown user. [proof: S25 AS-46] [code: packages/backend/libs/domains/community/application/moderation.service.ts#ModerationService]
- **S25.R-31** A post MUST be deletable by its author, an `ADMIN` or a `MODERATOR` (`403` for others), removed from every list and ranking, its comments unreachable, one `discussion.post_deleted` recorded, repeating a no-op. [proof: S25 AS-47] [code: packages/backend/libs/domains/community/application/post.service.ts#PostService]
- **S25.R-32** Ten zero-weight votes on one target within ten minutes MUST record one `discussion.vote_anomaly_detected` event per target per hour and a metric, and never block voting. [proof: S25 AS-48] [code: packages/backend/libs/domains/community/domain/anomaly.ts#evaluateAnomaly]
- **S25.R-33** After the whole cache is emptied counts and orders MUST return identical from the durable store, and every cache key MUST expire. [proof: S25 AS-49] [code: packages/backend/libs/domains/community/application/counts.service.ts#CountsService]
- **S25.R-34** The reconciliation MUST repair drifted live and durable counters and ranking entries from the vote store with one warning per drifted target, and a second run MUST change nothing. [proof: S25 AS-50] [code: packages/backend/libs/domains/community/application/reconcile.service.ts#ReconcileService]
- **S25.R-35** With the ranking cache down, `new`, `old` and one-post reads MUST work, `hot`, `top` and `best` MUST answer `degraded: true` from the newest 200 items, a vote MUST answer `503` `service_unavailable` and record nothing, and creates MUST continue and appear in the rankings once the cache returns. [proof: S25 AS-51] [code: packages/backend/libs/domains/community/application/board-query.service.ts#BoardQueryService]
- **S25.R-36** A store timeout MUST answer a generic `503` (no store name, query text or stack) and a retry with the same key MUST leave exactly one entity. [proof: S25 AS-52] [code: packages/backend/libs/domains/community/infra/scylla-store.ts#ScyllaStore]
- **S25.R-37** Every error MUST be `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a stable `code`. [proof: S25 AS-53] [code: packages/backend/libs/domains/community/domain/discussion-errors.ts#DiscussionError]
- **S25.R-38** Logs MUST carry the `requestId` and never a title, body or e-mail address, and the metrics for writes, votes, degraded reads and drift MUST be emitted. [proof: S25 AS-54] [code: packages/backend/libs/domains/community/domain/discussions-metrics.ts#discussionWriteCounter]
- **S25.R-39** A GET MUST change no stored state. [proof: S25 AS-55]
- **S25.R-40** Data written before S25 MUST become readable through the idempotent backfill job. [proof: S25 AS-50] [code: packages/backend/libs/domains/community/application/backfill.service.ts#BackfillService]

## Behaviors
- **S25.B-01** Given a product and a buyer, when the buyer posts twice with the same `Idempotency-Key`, then one post exists and both answers are the same. [proof: S25 AS-06]
- **S25.B-02** Given twelve top-level comments and partitions of five, when the thread is read in pages of four, then every comment appears once, in order, with its reply. [proof: S25 AS-18]
- **S25.B-03** Given 100 buyers, when all up-vote one post at once, then it shows 100 up-votes. [proof: S25 AS-29]
- **S25.B-04** Given twenty one-hour-old accounts voting for one post and one old account voting for another, then the second ranks first while the first still shows 20. [proof: S25 AS-44]
- **S25.B-05** Given a shadow-banned user, when they post and comment, then they see their content and nobody else does. [proof: S25 AS-46]
- **S25.B-06** Given the ranking cache emptied, when the board is read, then the same order returns. [proof: S25 AS-49]
- **S25.B-07** Given the event bus down, when a post is created, then it answers `201` and the event is published once the bus is back. [proof: S25 AS-07]

## Lifecycles
A post is visible, then deleted (one way). A comment is visible, then a tombstone (one way). A vote is none, up or down. A shadow ban is set or lifted for new content only.

## Owns
- ScyllaDB tables `posts`, `posts_by_board`, `board_months`, `comments_by_post`, `top_comments_by_post`, `comment_locator`, `post_buckets`, `votes_by_target`, `vote_counts`, `post_comment_counts`, `comment_reply_counts`, `shadow_bans`, `create_claims`, `recorded_events`, `pending_events`, `dead_events`, `recent_targets`, `recent_posts`.
- Redis keys `dsc:*` (every key expires) and the write-behind counter `discussions-votes`.
- Rate-limit policies `discussion.write` and `discussion.vote`.
- Topic `discussion.events`, jobs `discussions.*`.

## Decisions
- No PostgreSQL table: the outbox is a SQL table, so events are recorded in the owning store with the write and relayed from it.
- Counts are derived: the vote records and comment rows are the truth; every cache is rebuilt on a miss and a reconciliation repairs drift.
- Votes use compare-and-set on the record instead of a lock, so the store arbitrates and a lost lock cannot double a delta.

## Known gaps
- The throughput and latency success criteria (SC-001, SC-002, SC-003, SC-005) have no automated proof (listed in `specs/UNVERIFIED.md`).
- The real Kafka relay is proven with a spy of the bus; the started worker proves the module wiring, not a broker round trip.
- The platform answers `invalid_token` for a missing credential and `idempotency_in_flight` for a request in flight; the spec's `unauthorized` and `request_in_progress` are not used.
