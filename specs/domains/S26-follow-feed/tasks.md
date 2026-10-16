# Tasks: S26 — Follow graph and home feed (domain `community`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `data-model.md`, `research.md`, `contracts/follow-feed-api.md`, `contracts/events.md`, `quickstart.md`, constitution.
**Tests**: required (test-plan.md, VII.8): for each test-plan row the failing test task comes before the code task.
**Format**: `- [ ] Tnnn [P?] [USn?] description with file path`. `[P]` = different files, no dependency on an unfinished task.

Path shorthand: `COM` = `packages/backend/libs/domains/community`; `CON` = `packages/contracts/src/community`; `CQL` = `packages/backend/cql`. Backend commands run from `packages/backend`; e2e specs run through `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>`.

**Rules for every task**: no new `sequelize.transaction` (community opens none); do not edit sibling specs (follow-ups are in gaps.md); never create/edit `*.reviewed.json`; no task here runs boot/fresh-stack/journey/browser checks (L-019, deferred to the final checkpoint); undo by hand-editing only; all Redis keys `fd:`-prefixed with a TTL (III.9); `domain/` has no `Date.now()`/`new Date()`/`node:crypto`; `application/` imports no `infra/` (E2).

User stories: US1 follow/unfollow (P1) · US2 items in home feed (P1) · US3 celebrities merged at read (P1) · US4 return after a break / rebuild (P2) · US5 hidden/unavailable content (P1) · US6 fan-out health (P2).

---

## Phase 1: Setup (contracts, schema, config)

- [X] T001 Create additive migration `CQL/062_feed_s26.cql` per data-model.md: `ALTER following_by_user ADD active boolean, rel_ts bigint`; `ALTER feed_items ADD product_id text, shop_id text, post_id text`; new tables `following_by_time` (`((user_id), followed_at DESC, account_id)`), `following_counts` (`user_id`, `n int`), `celebrity_accounts` (`account_id`, `since`, `followers_at_promotion bigint`), `item_claims` (`((kind, source_key))`, `item_id timeuuid`, `created_at`), `product_copies` (`product_id`, `shop_id`, `title`, `price_minor bigint`, `currency`, `status text` ACTIVE/ARCHIVED/DELETED, `is_sandbox boolean`, `product_version bigint`, `updated_at`), `post_tombstones` (TTL 30 d), `fanout_done` (TTL 7 d), `pending_announcements` (`((hour_shard), item_id)`, TWCS, TTL 48 h), `dead_announcements` (`((day), item_id)`, TTL 14 d). No column or table dropped (III.11). (B7, B8)
- [X] T002 [P] Add zod schemas `FeedPage`, `FeedItemView` (typed payload per kind: `new_product`, `price_drop`, `drop_announced`, `auction_started`, `post`; integer money), `FollowingPage`, `FollowStatus`, error-code enum (`validation_failed`, `account_not_found`, `cannot_follow_self`, `following_limit_reached`, `invalid_cursor`, `rate_limited`, `rate_limiter_unavailable`, `rate_limit_cost_exceeded`, `feed_unavailable`) in `CON/feed.ts`; export from the contracts index. (B5, B6, D7, A5, A6)
- [X] T003 [P] Add `feed.item_published` v1 `{itemId, authorId, kind, createdAt}` schema in `CON/events.ts` (topic `feed.events`, key `authorId`) per contracts/events.md. (B6, S28 follow-up)
- [X] T004 [P] Add joi-validated feed config keys in `packages/backend/libs/common/config/` (celebrity threshold 10000, following limit 2000, window 800, celebrity recents 200, retention 90 d, active window 7 d, fan-out page 1000, rebuild concurrency 16 and process semaphore 64, per-call timeouts: timeline 150 ms, celebrity 400 ms, history 800 ms, hydration 600 ms, directory 300 ms, scan cap 5×limit).
- [X] T005 Register the `feed` aggregate (`FEED_AGGREGATE`) with the topic registry so `feed.events` is known to the publisher (E5, plan risk e). File: `COM/domain/feed-events.ts` + the existing registry call site.

## Phase 2: Foundational (blocking)

- [X] T006 Write failing unit spec `COM/domain/merge.spec.ts` (table-driven: empty, single, ties by `itemId`, duplicates, cursor, limit, 50 lists; `fast-check` property: output equals sorted de-duplicated union cut at limit and cursor). (AS-18 tie rule, AS-26, AS-31, D2)
- [X] T007 [P] Write failing unit spec `COM/domain/feed-cursor.spec.ts` (opaque keyset cursor for feed `(ms, itemId)` and following `(followed_at, account_id)`: round-trip, tamper → invalid). (AS-11, AS-19, D1)
- [X] T008 [P] Write failing unit spec `COM/domain/item-rules.spec.ts` (event → item mapping for every kind; non-qualifying events; price-drop table: any decrease on `changedFields ∋ priceMinor`, ≤ 1 per product per 24 h; integer money). (AS-14, B3, B5)
- [X] T009 [P] Write failing unit spec `COM/domain/version-guard.spec.ts` (product copy version monotonic, deletion-first, archive/restore, stale event ignored). (AS-17, B4)
- [X] T010 Implement `COM/domain/merge.ts` (k-way merge by `(ms, sortableId)` descending, de-dup, cursor, limit) until T006 passes. (D2)
- [X] T011 [P] Implement `COM/domain/feed-cursor.ts` until T007 passes. (D1)
- [X] T012 [P] Implement `COM/domain/item-rules.ts` until T008 passes. (B3, B5)
- [X] T013 [P] Implement `COM/domain/version-guard.ts` until T009 passes. (B4)
- [X] T014 [P] Add `COM/domain/feed-errors.ts` (DomainError subclasses with the `code`s of T002; rendered by the global problem+json filter). (A1)
- [X] T015 Move Redis key builders to `COM/domain/feed-keys.ts` with the `fd:` prefix and TTL constants from data-model.md (`act`, `tl`, `tlc`, `rb`, `cel`, `iscel`, `cf`); remove them from `application/`. (E2, III.9)
- [X] T016 Define ports and DI tokens in `COM/domain/ports.ts`: follow graph store, feed item store (claim + batch), timeline store, celebrity store, product-copy store, announcement store, shop directory (S03 `getShopsByIds`), account directory (S01 `getUsersByIds`), post lookup (S25 `getPostsByIds`), clock. No `infra/` import from `application/`. (E2, D-6)
- [X] T017 [P] Add `COM/domain/feed-metrics.ts` (placed in `domain/` so `application/` may use it, E2) registering the metrics of AS-50 (fan-out duration/lag `feed_fanout_lag_seconds`, pushes, degraded reads, rebuilds, relay backlog). (C6)
- [X] T018 Create `COM/feed-stores.module.ts` (`FeedStoresModule`) providing/exporting the infra adapters behind the tokens of T016, shared by the three feed modules (mirrors `discussions-stores.module.ts`). (L-018)
- [X] T019 Create shared test fixtures `COM/testing/feed-fixtures.ts`: seeding via `SessionIssuer` and exported services/events only (no `UserModel`/`ShopModel`/`ProductModel`), contract-valid event envelopes for S05/S21/S25, frozen clock, switchable failure wrappers at the exported-service edge (S03, S25) and for the timeline/durable stores, bus spy with pause/resume and failure switch. Each test creates its own data (L-005, L-006).

**Checkpoint**: unit specs green; contracts compile.

## Phase 3: US1 — Follow and unfollow accounts (P1) 🎯 MVP

**Goal**: durable, convergent follow graph with limit, counts, validation, privacy. **Independent test**: `follow-graph.e2e-spec.ts` (AS-01…AS-12, AS-51).

### Tests first
- [X] T020 [US1] Write failing `COM/follow-graph.e2e-spec.ts` ("Follow graph: follow, unfollow, limits and privacy"), real HTTP via `supertest`, responses parsed with `CON/feed.ts` schemas, persisted rows in both directions + counts asserted: AS-01 (follow shop, both directions, count, status), AS-02 replay, AS-03 (20 concurrent identical follows via `Promise.all`), AS-04 (malformed, unknown, deleted/DELETING shop, self → `422 cannot_follow_self`, one case per class, problem+json codes), AS-05 (unfollow, replay, missing, count never negative), AS-06 (follow racing unfollow ×20, both sides agree), AS-07 (limit 2,000 → `422 following_limit_reached`, re-follow at limit OK, race at edge), AS-08 (401 every route), AS-09 (frozen clock: `follow.write` 429 with `RateLimit`/`RateLimit-Policy` headers, `503 rate_limiter_unavailable` fail-closed, `feed.read` fail-open), AS-10 (IDOR), AS-11 (following list paging, newest first, `limit` 1–100, invalid cursor → 400), AS-12 (`/follow-status?accountIds=` ≤ 100, counts), AS-51 (reconciliation fixes counts and half-written relations; buyer-side wins). Old `feed.e2e-spec.ts` follow scenarios are covered by AS-01/AS-05 (L-017).

### Implementation
- [X] T021 [US1] Implement `COM/infra/scylla-follow.store.ts` (`ScyllaFollowStore`): LWT on `following_by_user` with per-relation sequence `rel_ts` (first follow, re-follow after unfollow keeps tombstone `active = false`); derived writes to `followers_by_account` and `following_by_time` `USING TIMESTAMP rel_ts`; limit reservation CAS on `following_counts` (`IF n = ?`); counts moved only by the request whose conditional write applied; reads clamp at 0; legacy rows (`active` null = true) migrate lazily; keyset list + status reads. (A2, A3, A4, R-1, R-2)
- [X] T022 [P] [US1] Implement ACL adapters `COM/infra/shop-directory.adapter.ts` (S03 `ShopQueryService.getShopsByIds`, `ACTIVE|SUSPENDED` followable; `DELETING|DELETED` not) and reuse/extend S25's identity adapter for users (S01 `getUsersByIds`), 300 ms timeout, fail → `feed_unavailable`. (A1)
- [X] T023 [US1] Implement `COM/application/follow.service.ts` (follow, unfollow, status batch, list; validation through the directory ports; `cannot_follow_self`, `account_not_found`, `following_limit_reached`; follow/unfollow delete `fd:tlc` and `fd:cf` of the user via the timeline port). (A1–A6, A9)
- [X] T024 [P] [US1] Implement `COM/api/feed.dto.ts` (account id shape, `limit`, `cursor`, `accountIds` ≤ 100 with unknown-parameter rejection) and rewrite `COM/api/feed.controller.ts` follow routes (`POST/DELETE /follow/:accountId`, `GET /me/following`, `GET /follow-status`) thin, `Firewall()`, per contracts/follow-feed-api.md. (A1, A5, A6, II.1)
- [X] T025 [P] [US1] Move policy numbers to `COM/rate-limit-policies.ts` with `definePolicies` + `forFeature` (`follow.write` 30/min/user fail-closed, `feed.read` 120/min/user fail-open) registered by the feed module; controllers use `@RateLimit`. (S50 follow-up, A8)
- [X] T026 [P] [US1] Implement `COM/application/follow-query.service.ts` (`FollowQueryService.getFollowerIds(accountId, {limit ≤ 1000, cursor?}) → {ids, nextCursor}`, active followers only). (S28 follow-up)
- [X] T027 [US1] Implement `COM/application/feed-reconcile.service.ts` (recompute `follower_counts` for accounts with ≥ 1 follower record, repair half-written relations from the buyer side, paged/resumable/paced; one-off `UNLINK` by explicit name of old unprefixed keys `tl:`, `celeb:`, `following:`, `followers:`, `feed:celebrities` on first run). (A7, AS-51)
- [X] T028 [US1] Run `follow-graph` until T020 is green (≤ 5 attempts per failing test; otherwise write the blocker to `questions.md`).

**Checkpoint**: US1 independently testable.

## Phase 4: US2 — New items reach the home feed (P1)

**Goal**: items from events, idempotent and ordered; basic push + read. **Independent test**: `feed-items.e2e-spec.ts` (AS-13–AS-17) and the read half of `feed-read.e2e-spec.ts` (AS-18–AS-21, AS-23).

### Tests first
- [X] T029 [US2] Write failing `COM/feed-items.e2e-spec.ts` ("Follow feed: items from events, idempotency and out-of-order delivery"): AS-13 (product event reaches an active follower; item shape; announcement recorded), AS-14 (one wired case per kind: `new_product`, `price_drop`, `drop_announced`, `auction_started`, `post`; non-qualifying events create nothing; 24 h price-drop rule), AS-15 (duplicate + 20 concurrent deliveries → one item), AS-16 (invalid payload dead-lettered with no side effects, for each consumer), AS-17 (out-of-order source events; missing product copy retried ≤ 5 times then dead-lettered). Events delivered through the real consumers.
- [X] T030 [US2] Write failing `COM/feed-read.e2e-spec.ts` ("Follow feed: home timeline, paging, hydration and degradation") **first part**: AS-18 (out-of-order pushes, ties by `itemId`), AS-19 (cursor paging without gaps/repeats incl. past the 800 window by pull continuation, while new items arrive), AS-20 (limit/unknown param/cursor validation → 400 `validation_failed`/`invalid_cursor`), AS-21 (empty feed), AS-23 (items older than 90 days not served), AS-43 (contract parse of every kind; integer money; exact payload fields per kind; `author.name`).

### Implementation
- [X] T031 [US2] Implement `COM/infra/scylla-feed-item.store.ts`: claim `INSERT … IF NOT EXISTS` on `item_claims` (`price_drop` claim `USING TTL 86400`), then one logged batch `feed_items` + `items_by_author` + `pending_announcements` with `USING TTL 7776000` (90 d); `month` = UTC `yyyymm`; reads by id batch and by author history. (B7, B8, R-4, R-5)
- [X] T032 [P] [US2] Implement `COM/infra/scylla-product-copy.store.ts` (version-guarded upsert, `DELETED` tombstone) and `post_tombstones` access. (B3, B4, D-7, D-12, R-6)
- [X] T033 [US2] Implement `COM/application/item-projection.service.ts` (event → claim → batch using `item-rules`/`version-guard`; schema-validated payloads; shop name/status through the shop directory; no `Product` read) and `COM/infra/feed-projectors.ts` (four `Projector` classes on S53: `products.events` — ignores `catalog.product_changed`, handles `product_created|updated|archived|restored|deleted`, replay-safe on the compacted topic; `discussion.events`; `auctions.events`; `feed.events` placeholder wired in T043; permanent errors dead-letter, transient retry, `SinkBackpressureError` pauses). (B1, B3, B4, D-7, D-12, S05 follow-up)
- [X] T034 [P] [US2] Implement `COM/infra/scylla-announcement.store.ts` and `COM/application/announcement-relay.service.ts` (pending → publish `feed.item_published` at least once → delete; invalid rows to `dead_announcements`). (B2, R-5)
- [X] T035 [P] [US2] Implement `COM/infra/feed.jobs.ts`: `declareJobType` with payload contracts beside the `JobPayloads` augmentation for `feed.relay-announcements`, `feed.relay-sweep`, `feed.reconcile`; schedules via `upsertSchedule`, catching `InvalidScheduleError`. (E5, S49 follow-up)
- [X] T036 [US2] Implement `COM/infra/redis-timeline.store.ts` (ZSET `fd:tl:{userId}`, members `sortableId`, score ms; Lua push/trim to window/expire; active marker `fd:act` sliding 7 d; batch active check; recents `fd:cel`) and `COM/application/fanout.service.ts` basic path (follower pages of 1,000 via `getFollowerIds`, active-only pipelined pushes, `fanout_done` marker, per-author ordered consumer on `feed.events`). (C3, R-3, R-7)
- [X] T037 [US2] Implement `COM/application/feed-read.service.ts` (pushed timeline candidates, merge, pull continuation from `items_by_author` past the window with scan cap 5×limit, keyset cursor, retention cut) and the `GET /feed?limit&cursor` route in `COM/api/feed.controller.ts` returning `{items, nextCursor, degraded?}`. (D1, D2, D3)
- [X] T038 [US2] Implement minimal `COM/application/feed-hydration.service.ts` (batched per source in parallel with timeouts; builds `FeedItemView`; author-still-followed filter). Visibility rules are completed in US5.
- [X] T039 [US2] Run `feed-items` and the first part of `feed-read` until T029/T030 are green.

## Phase 5: US3 — Celebrity accounts merged at read time (P1)

**Independent test**: `feed-celebrity.e2e-spec.ts` (AS-24–AS-30).

- [X] T040 [US3] Write failing `COM/feed-celebrity.e2e-spec.ts` ("Follow feed: celebrity accounts merged at read time"): AS-24 (zero pushes, every follower sees the item once), AS-25 (normal author pushes to active only), AS-26 (one wired merge of pushed + several celebrities, dedupe), AS-27 (promotion racing a publish ×20), AS-28 (status and recents survive loss of Redis), AS-29 (sticky), AS-30 (one celebrity read times out → partial feed, `degraded: true`).
- [X] T041 [US3] Implement `COM/infra/scylla-celebrity.store.ts` (`celebrity_accounts`, `IF NOT EXISTS` promotion, never deleted) with read-through `fd:iscel:{accountId}`; promotion check on follow when `followerCount ≥ threshold` (in `follow.service.ts`) and in fan-out. (C1, R-3)
- [X] T042 [US3] Extend `fanout.service.ts` (celebrity authors: no follower pushes, only recents `fd:cel` 200/24 h) and `feed-read.service.ts` (followed-celebrity list `fd:cf` 1 h from the follow store, recents read with 400 ms timeout, rebuild of recents from `items_by_author` on loss, per-author failure → omit + `degraded`). (C1, C2, D6, AS-30)
- [X] T043 [US3] Run `feed-celebrity` until T040 is green.

## Phase 6: US4 — Return after a break (P2)

**Independent test**: `feed-rebuild.e2e-spec.ts` (AS-32–AS-37).

- [X] T044 [US4] Write failing `COM/feed-rebuild.e2e-spec.ts` ("Follow feed: inactive users and rebuild on return"): AS-32 (no pushes while inactive, rebuild on return, becomes active), AS-33 (timeline lost for an active user → rebuild), AS-34 (10 concurrent first reads identical, no duplicates), AS-35 (push during rebuild neither lost nor duplicated), AS-36 (follow shows recent items, unfollow hides, re-follow shows), AS-37 (concurrency bound 16, per-call timeout, retry on next read, history read failure leaves marker incomplete).
- [X] T045 [US4] Implement `COM/application/timeline-rebuild.service.ts` (single flight `fd:rb` `SET NX PX`; pull 50 items/author from last 60 days with concurrency 16 plus process semaphore 64; `ZUNIONSTORE` merge so concurrent pushes survive; `fd:tlc` completion marker only when every author was read; active marker set only on success). (D4, R-8)
- [X] T046 [US4] Wire rebuild into `feed-read.service.ts` (missing/incomplete timeline for an active or returning user; follow/unfollow invalidation via `tlc`). (D4, A9)
- [X] T047 [US4] Run `feed-rebuild` until T044 is green.

## Phase 7: US5 — Hidden and unavailable content never shows (P1)

**Independent test**: remaining `feed-read.e2e-spec.ts` rows (AS-38–AS-42).

- [X] T048 [US5] Extend `COM/feed-read.e2e-spec.ts` with failing tests: AS-38 (post deleted, product archived/restored/deleted, sandbox, shop suspended/deleted hide items; restored reappears), AS-39 (page fill from further candidates, scan bound, no empty page with a cursor), AS-40 (batched hydration, sources in parallel), AS-41 (S25 and S03 lookups fail → items omitted, `degraded`, no leak), AS-42 (timeline store down → pull with `degraded`; durable store down → `503 feed_unavailable`, no stack/store/query text in body, SC-010).
- [X] T049 [US5] Complete `feed-hydration.service.ts`: one batch per source (posts via `getPostsByIds` ≤ 100, shops via `getShopsByIds`, products from the own copy), fail-closed visibility (deleted/shadow post, non-ACTIVE or sandbox product, non-ACTIVE shop, tombstoned), per-source 600 ms timeout. (D5, D6)
- [X] T050 [US5] Complete `feed-read.service.ts`: fill loop up to the scan cap, Redis-down fallback to pull with `degraded: true`, durable-store failure → `feed_unavailable` (503, problem+json without internals). (D5, D6)
- [X] T051 [US5] Run `feed-read` until T030/T048 are green.

## Phase 8: US6 — Fan-out stays healthy (P2)

**Independent test**: `feed-fanout.e2e-spec.ts` (AS-22, AS-44–AS-50).

- [X] T052 [US6] Write failing `COM/feed-fanout.e2e-spec.ts` ("Follow feed: fan-out, backpressure, recovery and operations"): AS-22 (`feed.item_published` duplicate delivery + invalid payload), AS-44 (follower paging, pipelined batched writes), AS-45 (saturation pauses the consumer, resume, nothing lost), AS-46 (failure part-way, redelivery, exactly once), AS-47 (per-author order), AS-48 (bus down at storing time, announced after recovery), AS-49 (every `fd:` key has a TTL, active marker slides), AS-50 (structured `feed.fanout.completed` / `feed.degraded` / `feed.fanout.failed` lines without follower ids; metrics).
- [X] T053 [US6] Complete `fanout.service.ts`: `SinkBackpressureError` pause/resume, redelivery-safe resume with `fanout_done` marker and read-time dedupe, structured log lines and metrics (T017). (C3–C6)
- [X] T054 [US6] Run `feed-fanout` until T052 is green.

## Phase 9: Modules, barrel, cleanup

- [X] T055 Create `COM/feed.module.ts` (HTTP; **not** `@Global`, E4), `COM/feed-worker.module.ts` (relay/sweep/reconcile jobs), `COM/feed-projectors.module.ts` (the four projectors); each imports `FeedStoresModule` and every event definition, ACL adapter and rate-limit policy it needs so each boots on its own (L-018, L-015). Rewrite `COM/index.ts` to export only modules and `FollowQueryService` (no consumer/projector/publisher; D-8, E3).
- [X] T056 Swap `FeedFanoutConsumer`/`ProductFeedProjector`/`FeedPublisherModule` for `FeedProjectorsModule` in `packages/backend/apps/projector/src/projector.module.ts`; import `FeedWorkerModule` in `apps/worker`; keep `FeedModule` in `apps/core/src/core.module.ts`; add the `feed` topic/queue config if any consumed queue is named (L-002, L-020: define it in `elasticmq.conf` when needed).
- [X] T057 Delete replaced files: `COM/application/feed.service.ts`, `COM/application/feed-publisher.service.ts`, `COM/feed-publisher.module.ts`, `COM/infra/fanout.consumer.ts`, `COM/infra/product-feed.projector.ts`, `COM/feed.e2e-spec.ts` (scenarios preserved by named AS rows, L-017); fix every remaining import (grep `FeedPublisher`, `FeedService`, `feed-publisher` across `packages/`).

## Phase 10: Polish, gates and docs (code/docs only)

- [X] T058 [P] Static gates: `pnpm exec tsc --noEmit` (backend, contracts), ESLint on touched packages, `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict` (zero community lines), `pnpm check:module-graph`, `pnpm check:model-registry`; add a grep check that only `scylla-follow.store.ts` writes `followers_by_account`/`following_by_time`. Fix findings.
- [X] T059 [P] Write the k6 script `scripts/load-tests/feed.test.js` and the `loadtest:feed` entry in `packages/backend/package.json` (SC-001 fan-out lag for 10,000 followers, 30% active; SC-004 read p95 at 1/2/4 instances and a 500-account rebuild). Written, not run. Ensure `quickstart.md` "Ops artifacts" and the two `specs/UNVERIFIED.md` rows (SC-001, SC-004, status "not run") stay accurate; never describe them as verified.
- [X] T060 [P] Create the living page `docs/spec/capabilities/S26-follow-feed.md` (rules and behaviors of follow graph, feed, celebrity, rebuild, hiding, fan-out) with `[proof: …]` anchors on the six e2e files / four unit specs and `[code: …]` anchors on the services; run `python3 scripts/livespec/check.py` and fix. Do not create or edit any `*.reviewed.json`.
- [X] T061 Re-verify `gaps.md`: every item A1–A9, B1–B8, C1–C6, D1–D7, E1–E5, D-6, D-7, D-8, D-12 maps to a done task above (list below); sibling follow-ups section stays as written.
- [X] T062 Run the whole capability suite once in batches of fresh processes (L-008): `libs/domains/community/domain`, `follow-graph`, `feed-items`, `feed-read`, `feed-celebrity`, `feed-rebuild`, `feed-fanout`, then `libs/domains/community/discussions` (S25 still green). A batch without its summary line is a crash: rerun that batch alone. Long runs: `nohup` into a file in this folder and poll in the foreground with `sleep 240`.

---

## Gap → task map

A1 T022–T024 · A2/A3/A4 T021 · A5 T024 · A6 T024 · A7 T027 · A8 T025 · A9 T023, T046 · B1 T033, T057 · B2 T034 · B3 T012, T033 · B4 T013, T033 · B5 T002, T012 · B6 T003 · B7/B8 T001, T031 · C1/C2 T041–T042 · C3 T036, T053 · C4 T053 · C5 T052 · C6 T017, T053 · D1 T011, T037 · D2 T010 · D3 T037 · D4 T045 · D5 T049 · D6 T042, T050 · D7 T002 · E1 T020, T029, T030, T040, T044, T048, T052 · E2/D-6 T015–T016 · E3/D-8 T055 · E4 T055 · E5 T005, T035 · D-7/D-12 T032–T033 · Follow-ups: S05 T033; S28 T003, T026; S29 none (no image in payload, noted in gaps.md); S49 T035; S50 T025, T020.

## Dependencies and order

Phase 1 → Phase 2 → US1 (independent MVP) → US2 (needs US1 `FollowQueryService`, T026) → US3, US4, US5 (each extends US2 read/fan-out; can follow in any order, US5 before release) → US6 → Phase 9 → Phase 10. Modules (T055) are needed for e2e of each story: create the minimal `FeedModule`/`FeedWorkerModule`/`FeedProjectorsModule` skeletons while implementing T028 and extend them per story; T055 finalises them.

## Parallel examples

- Phase 2: T007, T008, T009 then T011, T012, T013, T014, T017 (distinct files).
- US1: T022, T024, T025, T026 after T021.
- US2: T032, T034, T035 alongside T031.
- Phase 10: T058, T059, T060.

## Strategy

MVP = Phases 1–3 (US1). Then US2 for end-to-end value, US5 before exposure (fail-closed visibility), then US3/US4/US6. Every test task precedes its implementation task; no task adds a runtime check (L-019).
