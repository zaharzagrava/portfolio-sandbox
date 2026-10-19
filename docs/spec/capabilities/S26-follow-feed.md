---
id: S26
title: Follow graph and home feed (follow, items from events, fan-out on write with celebrity merge, rebuild, hiding)
kind: capability
status: draft
depends_on: [S01, S03, S05, S25, S28, S50]
concepts: [problem-json-errors, rate-limit-policy, cache-layers, projection-and-replay]
models: []
scope:
  - packages/backend/libs/domains/community/api/feed*.ts
  - packages/backend/libs/domains/community/application/follow*.ts
  - packages/backend/libs/domains/community/application/feed-*.ts
  - packages/backend/libs/domains/community/application/fanout.service.ts
  - packages/backend/libs/domains/community/application/celebrity-recents.service.ts
  - packages/backend/libs/domains/community/application/item-projection.service.ts
  - packages/backend/libs/domains/community/application/timeline-rebuild.service.ts
  - packages/backend/libs/domains/community/application/announcement-relay.service.ts
  - packages/backend/libs/domains/community/domain/feed-*.ts
  - packages/backend/libs/domains/community/domain/item-rules.ts
  - packages/backend/libs/domains/community/domain/merge.ts
  - packages/backend/libs/domains/community/domain/version-guard.ts
  - packages/backend/libs/domains/community/infra/feed*.ts
  - packages/backend/libs/domains/community/infra/scylla-follow.store.ts
  - packages/backend/libs/domains/community/infra/scylla-feed-item.store.ts
  - packages/backend/libs/domains/community/infra/scylla-celebrity.store.ts
  - packages/backend/libs/domains/community/infra/scylla-announcement.store.ts
  - packages/backend/libs/domains/community/infra/scylla-product-copy.store.ts
  - packages/backend/libs/domains/community/infra/redis-timeline.store.ts
  - packages/backend/libs/domains/community/infra/redis-follow-cache.ts
  - packages/backend/libs/domains/community/feed*.module.ts
  - packages/backend/libs/domains/community/follow-query.module.ts
  - packages/contracts/src/community/feed.ts
---
# S26 - Follow graph and home feed (follow, items from events, fan-out on write with celebrity merge, rebuild, hiding)
## Purpose
A signed-in buyer follows shops and other users and reads one home feed of what they publish: new products, price drops, discussion posts, announced drops and started auctions. Items are created only from events and kept once, with a copy of what they show. A normal author's item is pushed (as an identifier) into the timelines of its active followers; a celebrity's is never pushed but merged at read time from a short recent list. A returning reader gets a timeline rebuilt from durable history, and an item that is deleted, hidden or no longer followed never shows. Durable data lives in ScyllaDB, the pushed timelines in Redis (a rebuildable cache), and the follow graph is readable by other domains through `FollowQueryService` only.

## Entry points
- `POST /api/follow/:accountId`, `DELETE /api/follow/:accountId`, `GET /api/me/following`, `GET /api/follow-status`, `GET /api/feed`. [code: packages/backend/libs/domains/community/api/feed.controller.ts#FeedController]
- `FollowQueryService`: followers of an account and follower counts for other domains (S28 reads it). [code: packages/backend/libs/domains/community/application/follow-query.service.ts#FollowQueryService]
- Consumers `products.events`, `discussion.events`, `auctions.events` and `feed.events` (the four projectors, listed by `FeedProjectorsModule.projectors`). [code: packages/backend/libs/domains/community/infra/feed-projectors.ts#FeedFanoutProjector]
- Topic `feed.events`: `feed.item_published`. [code: packages/backend/libs/domains/community/domain/feed-events.ts#FEED_AGGREGATE]
- Jobs `feed.relay-announcements`, `feed.relay-sweep`, `feed.reconcile`. [code: packages/backend/libs/domains/community/infra/feed.jobs.ts#FeedJobs]

## Rules
- **S26.R-01** Following and unfollowing an account (`shop:<uuid>` or `user:<uuid>`) MUST answer `204` with no body and be idempotent: a repeated follow keeps `followedAt` and the count, and an unfollow of a never-followed or vanished account is `204`. [proof: S26 AS-01, S26 AS-02, S26 AS-05] [code: packages/backend/libs/domains/community/application/follow.service.ts#FollowService]
- **S26.R-02** Each relation MUST be readable from both sides, the two sides MUST converge after a partial failure, and the follower count MUST equal the number of follower records, repaired by the scheduled reconciliation. [proof: S26 AS-06, S26 AS-51] [code: packages/backend/libs/domains/community/application/feed-reconcile.service.ts#FeedReconcileService]
- **S26.R-03** Twenty concurrent identical follows MUST leave one relation per direction and a count of 1, and a follow racing an unfollow MUST end with both directions agreeing and the count equal to the number of relations. [proof: S26 AS-03, S26 AS-06] [code: packages/backend/libs/domains/community/infra/scylla-follow.store.ts#ScyllaFollowStore]
- **S26.R-04** Following an unknown account, an unknown or deleted user or a `DELETING`/`DELETED` shop MUST be `404` `account_not_found`; a `SUSPENDED` shop can be followed; following oneself is `422` `cannot_follow_self`; a malformed ID is `400`. [proof: S26 AS-04] [code: packages/backend/libs/domains/community/infra/shop-directory.adapter.ts#ShopDirectoryAdapter]
- **S26.R-05** A buyer MUST NOT follow more than the limit (default 2,000) accounts, also under concurrent requests (`422` `following_limit_reached`); a re-follow at the limit succeeds. [proof: S26 AS-07] [code: packages/backend/libs/domains/community/application/follow.service.ts#FollowService]
- **S26.R-06** A buyer MUST list only their own follows, newest first, with `limit` 1 to 100 (default 50) and an opaque cursor, and MUST read follow status and count for up to 100 accounts in one call (one entry per requested ID in request order, duplicates collapsed). [proof: S26 AS-10, S26 AS-11, S26 AS-12] [code: packages/backend/libs/domains/community/application/follow-query.service.ts#FollowQueryService]
- **S26.R-07** Every route MUST answer `401` problem+json without credentials; follow writes MUST be limited to 30 a minute per user and fail closed (`429` `rate_limited` with `Retry-After`, `503` `rate_limiter_unavailable`), feed and list reads to 120 a minute and fail open. [proof: S26 AS-08, S26 AS-09] [code: packages/backend/libs/domains/community/rate-limit-policies.ts#communityRatePolicies]
- **S26.R-08** A cursor MUST be an HMAC-signed opaque value of its list: an edited one, one of the other list, one signed with another secret or one of the wrong shape MUST be `400` `invalid_cursor`; the feed cursor carries `(ms, itemId)`. [proof: S26 AS-11, S26 AS-19, S26 AS-20] [code: packages/backend/libs/domains/community/domain/feed-cursor.ts#createFeedCursorCodec]
- **S26.R-09** `catalog.product_created` of an `ACTIVE`, non-sandbox product MUST make a `new_product` item, a lower price a `price_drop` (at most one per product per 24 hours), `discussion.post_created` a `post` item of the user, `auction.created` a `drop_announced` and `auction.opened` an `auction_started` item; price increases, equal prices, sandbox and non-`ACTIVE` creations make none. [proof: S26 AS-13, S26 AS-14] [code: packages/backend/libs/domains/community/domain/item-rules.ts#productItem]
- **S26.R-10** Item creation MUST be idempotent per source, also under 20 concurrent deliveries, with no dependence on a time-limited marker. [proof: S26 AS-15] [code: packages/backend/libs/domains/community/application/item-projection.service.ts#ItemProjectionService]
- **S26.R-11** The feed MUST keep its own product copy, apply an event only when its `productVersion` is newer, remember a deletion that arrives first, and never read the catalog tables; an event whose product copy is missing MUST be retried (at most 5 attempts) and not produce a partial item. [proof: S26 AS-17] [code: packages/backend/libs/domains/community/domain/version-guard.ts#applyProductEvent]
- **S26.R-12** Every consumer MUST validate its payload and dead-letter an invalid one with no effect, and a duplicate delivery MUST do nothing. [proof: S26 AS-16, S26 AS-22] [code: packages/backend/libs/domains/community/infra/feed-projectors.ts#FeedProductsProjector]
- **S26.R-13** Every stored item MUST be announced at least once on `feed.item_published`, also when the bus was down at storing time and without redelivery of the source event; repeated announcements MUST be harmless. [proof: S26 AS-13, S26 AS-48] [code: packages/backend/libs/domains/community/application/announcement-relay.service.ts#AnnouncementRelayService]
- **S26.R-14** Items and per-author history older than 90 days MUST NOT be served and MUST expire, and every in-memory key MUST carry a TTL. [proof: S26 AS-23, S26 AS-49] [code: packages/backend/libs/domains/community/infra/redis-timeline.store.ts#RedisTimelineStore]
- **S26.R-15** A normal author's item MUST be pushed as an identifier into its active followers' timelines only, in pipelined batches per follower page, keeping at most the window (default 800) newest entries; inactive followers (no feed read within 7 days) MUST receive no write. [proof: S26 AS-25, S26 AS-44] [code: packages/backend/libs/domains/community/application/fanout.service.ts#FanoutService]
- **S26.R-16** An account at or above the celebrity threshold (default 10,000 followers) MUST never be fanned out: its newest 200 items go to a bounded recent list merged into each follower's read, and its status derives from the durable count, survives loss of in-memory state and is never demoted automatically. [proof: S26 AS-24, S26 AS-28, S26 AS-29] [code: packages/backend/libs/domains/community/application/celebrity-recents.service.ts#CelebrityRecentsService]
- **S26.R-17** A page MUST be the newest-first merge of the pushed timeline and the celebrity recents, ties by `itemId` descending, without duplicates and honouring the cursor, whatever the order of the pushes; a promotion racing a publish MUST lose and duplicate nothing. [proof: S26 AS-18, S26 AS-26, S26 AS-27, S26 AS-31] [code: packages/backend/libs/domains/community/domain/merge.ts#mergeNewestFirst]
- **S26.R-18** Fan-out MUST be asynchronous and ordered per author, MUST pause the partition when the timeline store is saturated and resume after a cooldown, and a failure part-way MUST be completed by redelivery with each active follower holding the item exactly once. [proof: S26 AS-45, S26 AS-46, S26 AS-47] [code: packages/backend/libs/domains/community/infra/feed-projectors.ts#FeedFanoutProjector]
- **S26.R-19** `GET /api/feed` MUST page by keyset (`limit` 1 to 50, default 30), end with `nextCursor: null`, answer an empty page for a buyer who follows no one and continue past the pushed window from per-author history without gap or repeat, also while new items arrive. [proof: S26 AS-19, S26 AS-20, S26 AS-21] [code: packages/backend/libs/domains/community/application/feed-read.service.ts#FeedReadService]
- **S26.R-20** Each item MUST have exactly `{itemId, kind, author, title, payload, createdAt}` with a payload of its kind, integer minor-unit money and the shop name or `null` for a buyer, and the page MUST parse with the contract schema. [proof: S26 AS-43] [code: packages/contracts/src/community/feed.ts#feedItemViewSchema]
- **S26.R-21** A reader inactive for more than 7 days, or without a pushed timeline, MUST get it rebuilt from the recent items (up to 50 per author, 60 days) of every followed non-celebrity account; the rebuild MUST be concurrency-bounded (16 history reads), time-bounded, safe under concurrent reads and pushes, and recorded complete only when every author was read. [proof: S26 AS-32, S26 AS-33, S26 AS-34, S26 AS-35, S26 AS-37] [code: packages/backend/libs/domains/community/application/timeline-rebuild.service.ts#TimelineRebuildService]
- **S26.R-22** Following an account MUST show its recent items on the next read and unfollowing MUST hide them on the next read. [proof: S26 AS-36] [code: packages/backend/libs/domains/community/application/feed-read.service.ts#FeedReadService]
- **S26.R-23** Items MUST be hidden at read time when a post is absent from S25's batch query, a product copy is not `ACTIVE` or is sandbox, or the author shop is not `ACTIVE`; the page MUST be filled from further candidates (at most 5 x `limit` scanned) and `nextCursor` stay non-null while candidates remain. [proof: S26 AS-38, S26 AS-39] [code: packages/backend/libs/domains/community/application/feed-hydration.service.ts#FeedHydrationService]
- **S26.R-24** Items MUST be hydrated in batches (one read per source per page, independent sources in parallel under timeouts); when a source that decides visibility is down its items MUST be omitted and the page marked `degraded: true`. [proof: S26 AS-30, S26 AS-40, S26 AS-41] [code: packages/backend/libs/domains/community/application/feed-hydration.service.ts#FeedHydrationService]
- **S26.R-25** With the timeline store down the feed MUST be built by pull from durable history, `degraded: true`; with the durable store down it MUST answer `503` `feed_unavailable` with `Retry-After` and no internal detail. [proof: S26 AS-42] [code: packages/backend/libs/domains/community/application/feed-read.service.ts#FeedReadService]
- **S26.R-26** Fan-out, rebuild, degradation and consumer pauses MUST emit one structured line and the metrics `feed_fanout_lag_seconds`, `feed_fanout_pushed_total`, `feed_rebuild_total`, `feed_degraded_total` and `feed_consumer_paused_total`, with no follower IDs or personal data. [proof: S26 AS-50] [code: packages/backend/libs/domains/community/domain/feed-metrics.ts#feedFanoutLag]
- **S26.R-27** A product created by a bulk import or an integration sync (the event's `source` is not `seller`) MUST NOT produce one `new_product` item per product for followers; a seller's own single create still does. [proof: S26 AS-60] [code: packages/backend/libs/domains/community/domain/item-rules.ts#productItem]

## Behaviors
- **S26.B-01** Given a buyer, when they follow a shop twice, then both answers are `204` and the follower count is 1. [proof: S26 AS-02]
- **S26.B-02** Given 20 buyers following one shop at once, then it has 20 followers and 20 relations. [proof: S26 AS-03]
- **S26.B-03** Given a shop that publishes a product, when an active follower reads the feed, then the `new_product` item is the first entry, stored and announced once. [proof: S26 AS-13]
- **S26.B-04** Given an author above the celebrity threshold, when it publishes, then no follower timeline is written and every follower still sees the item. [proof: S26 AS-24]
- **S26.B-05** Given a follower who was away, when they read, then a rebuild returns the recent items of all followed authors newest first and marks them active. [proof: S26 AS-32]
- **S26.B-06** Given a post that is deleted, when its follower reads the feed, then the post is absent and older items fill the page. [proof: S26 AS-39]
- **S26.B-07** Given the in-memory stores wiped, when a buyer reads, then the same items return from durable data. [proof: S26 AS-33]
- **S26.B-08** Given a saturated timeline store, when it recovers, then every active follower holds each item exactly once. [proof: S26 AS-45]

## Lifecycles
A relation is absent or active (a re-follow after an unfollow is a fresh relation). A feed item is stored once and never edited; it is served until its author is unfollowed, its source is hidden or deleted, or it ages past 90 days. A reader's timeline is absent, building, or complete; it is active while read within 7 days.

## Owns
- ScyllaDB tables of the follow graph, the feed items, per-author history, product copies, celebrity status and the announcement queue (`packages/backend/cql/062_feed_s26.cql`).
- Redis keys `fd:*` (every key expires).
- Rate-limit policies `follow.write` and `feed.read`.
- Topic `feed.events`, jobs `feed.*`.

## Decisions
- No PostgreSQL table: the announcement is recorded with the item in the owning store and relayed from there.
- Push identifiers, never bodies; hydrate and filter at read time, so a hidden source disappears without touching any timeline.
- Celebrity status derives from the durable follower count, so wiping Redis cannot demote anyone.
- Other domains read followers through `FollowQueryService`; no module outside `community` imports the stores.

## Known gaps
- The throughput and latency success criteria SC-001 (fan-out lag for 10,000 followers) and SC-004 (read p95 and rebuild time) have no automated proof; the k6 script `loadtest:feed` is written but not run (listed in `specs/UNVERIFIED.md`).
- No web page owns the home feed or the follow button (`specs/domains/S26-follow-feed/questions.md`).
- The `libs/domains/community/domain` unit spec `content.spec.ts` (S25) fails to load the ESM `marked` package under Jest; it predates this capability.
