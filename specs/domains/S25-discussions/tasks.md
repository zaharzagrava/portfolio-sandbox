---

description: "Task list for S25 — Product discussions (domain `community`)"
---

# Tasks: S25 — Product discussions (domain `community`)

**Input**: `plan.md`, `spec.md` (AS-01–AS-55, FR-001–FR-074, SC-001–SC-008), `test-plan.md`, `gaps.md` (A1–G8, D-6/D-7/D-8/D-12), `questions.md` (defaults accepted), `data-model.md`, `contracts/discussions-api.md`, `contracts/events.md`, `research.md`, `quickstart.md`, constitution.

**Tests**: REQUIRED (test-plan.md, constitution VII). Every test-plan row has a failing-test task BEFORE its code task. Seed users/products only through shared fixture helpers (D-7); concurrency tests use `Promise.all` ×20 (L-005, L-006: each test creates its own data, `createIsolatedProduct` for anything consuming stock); a test must be able to fail (L-003: no "A or B" assertions).

## Conventions

- `C/` = `packages/backend/libs/domains/community/`. `CQL/` = `packages/backend/cql/`. `CT/` = `packages/contracts/src/`. Run backend commands from `packages/backend`.
- Run e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern>`; narrowest test first, whole capability suite once at the end in batches of fresh processes (L-008). After 5 failed fixes of the same test: stop, write blocker/what was tried/hypothesis into `questions.md`.
- No `sequelize.transaction` anywhere (`.tx.baseline` = 0; community opens none). No `git checkout/restore/reset/stash/clean`; undo by hand. Never create or edit `*.reviewed.json`.
- Format: `- [ ] Txxx [P?] [USn?] description with path`. `[P]` = different files, no dependency on an unfinished task.

---

## Phase 1: Setup

- [X] T001 Read `research.md` R-1…R-13 and `data-model.md`; confirm topic registry maps aggregate type `discussion` → topic `discussion.events` (grep `libs/infrastructure/events`); if absent add the registration there and note it under "Spec changes" in `gaps.md` (contracts/events.md, plan risk a)
- [X] T002 Write `CQL/060_discussions_s25.cql` (additive only): columns `shadow boolean`, `deleted_by text`, `html_version int` on `posts`/`comments_by_post`; `posts_by_board` `+shadow +deleted`; `comments_by_post` `+depth tinyint +root_id`; `comment_locator` `+depth +author_id +parent_id`; `votes_by_target` `+weight tinyint +cast_at timestamp +version int +target_type text`; `vote_counts` `+wups counter +wdowns counter`; new tables `board_months`, `top_comments_by_post`, `post_buckets`, `post_comment_counts`, `comment_reply_counts`, `shadow_bans`, `create_claims`, `recorded_events`, `pending_events` (TWCS, `gc_grace_seconds = 3600`), `dead_events`, `recent_targets`, `recent_posts`, plus new `votes_by_user` replacement keyed `((user_id, target_id))` only if the plan keeps it (C8: not written; dropped in a later contract step). Apply with `pnpm test:stack:migrate` and confirm every table exists (L-011: compare with the doctor script)
- [X] T003 [P] Add discussion config keys (top-level partition size default 5000, ranking cap 1000, TTLs, first-page cache 5 s, timeouts Scylla read 800 ms / write 1500 ms / Redis 150 ms / directory 300 ms / catalog 300 ms, page default 25 max 50, scan cap 20000, cursor HMAC secret) to the joi config schema in `packages/backend/libs/common/config/` and the test env; startup fails on invalid values (VIII)
- [X] T004 [P] Add `fast-check`, `marked`, `sanitize-html` to `packages/backend` devDependencies/dependencies if missing (check `package.json` first)

## Phase 2: Foundational (blocks all stories)

**Purpose**: contracts, errors, ports, pure logic shared by several stories, fault-injecting test fixtures.

- [X] T005 [P] Extend `CT/community/discussions.ts` with zod schemas `PostView` (`postId, boardId, authorId, title, bodyHtml, createdAt, score, ups, downs, myVote, commentCount, degraded?`), `CommentView`, `CommentNode`, `PostPage`, `CommentThreadPage`, `CommentRepliesPage`, `VoteResult {targetId, targetType, ups, downs, score, myVote}`, `CreatePostRequest`, `CreateCommentRequest`, `VoteRequest`, enums for sort/window and the error `code` list; export from the package index (G5, FR-073, A7, B5, C6)
- [X] T006 [P] Create `CT/community/events.ts` with `defineEvent` schemas for `discussion.post_created`, `discussion.post_deleted`, `discussion.comment_created`, `discussion.comment_deleted`, `discussion.vote_anomaly_detected` (payloads exactly as `contracts/events.md`); export from the index (G1, FR-060; S28 follow-up: names/fields confirmed)
- [X] T007 [P] Create `C/domain/discussion-errors.ts`: `DomainError(code, status)` family covering `validation_failed, unauthorized, forbidden, board_not_found, board_closed, post_not_found, parent_not_found, parent_deleted, comment_not_found, target_not_found, target_deleted, max_depth_exceeded, request_in_progress, idempotency_key_required, idempotency_key_reuse, self_vote_not_allowed, vote_in_progress, invalid_cursor, user_not_found, service_unavailable`; confirm the global filter renders `code` in problem+json (F4, FR-070)
- [X] T008 Create `C/domain/ports.ts` + tokens: post/comment/vote/claim/event/shadow stores, rank/count/page caches, `AccountDirectory`, `BoardGate`, clock/random (D-6, G6); `application/` must import nothing from `infra/`
- [X] T009 [P] Create `C/discussions.fixtures.ts`: shared-helper user/product/moderator seeding (identity `SessionIssuer`, catalog exported services; `createdAt` override for account age), frozen/advanceable clock, switchable fault wrappers at the Scylla/Redis driver edge (cache down, store timeout, row-read counter), event-bus spy with switchable failure, user-directory fault, config overrides (partition size 5, cap 3)
- [X] T010 [P] Unit spec first, then code: `C/domain/ids.spec.ts` (ID time = `createdAt`; same-millisecond uniqueness; sort by ID = sort by time; `sortableId` timestamp first) → `C/domain/ids.ts` (timeuuid from injected clock + RandomSource, `sortableId`, `compareTimeUuid`) (A3, B7, AS-01, AS-19, AS-55)
- [X] T011 [P] Unit spec first, then code: `C/domain/paths.spec.ts` (depth table 0–8, thread order, bucket assignment/spill, replies stay with root) → rewrite `C/domain/paths.ts` clockless: no `node:crypto`, no `Date.now()` (B3, B7, AS-14, AS-15, AS-18)
- [X] T012 [P] Unit spec first, then code: `C/domain/cursor.spec.ts` (opaque round trip, kinds `hot|top|new|best|old|replies`, scope binding, tamper → `invalid_cursor`) → `C/domain/cursor.ts` (`base64url(kind|scope|position|hmac)`) (D1, AS-20, AS-35, AS-39)
- [X] T013 [P] Unit spec first, then code: `C/domain/content.spec.ts` (FR-040 allow-list table incl. h1/h2→h4 mapping, link `rel`/`target`; title normalisation: trim, 3–300 code points, no U+0000–U+001F, U+007F, U+202A–U+202E, U+2066–U+2069; nesting counter, 20 levels; XSS corpus: `javascript:`, `data:`, `vbscript:`, entity-encoded schemes, svg/math, mutation XSS) → rewrite `C/domain/content.ts` (render + `HTML_POLICY_VERSION`, complexity gate before `marked.parse`, post body ≤ 40,000 / comment 1–10,000 code points after trim) (A5, E1, E2, E3, E4, AS-03, AS-08, AS-09, AS-12)
- [X] T014 [P] Unit spec first, then code: add to `C/domain/ranking.spec.ts` the formula tables (10× = 45,000 s, signs, rounding; Wilson (0,0), (1,0), (90,10), (9,1), monotonicity) and `C/domain/top-window.spec.ts` (window table, inclusive boundary) → `C/domain/top-window.ts`; keep `hotScore`/`wilsonLowerBound` taking weighted inputs and `now` (D4, D10, AS-34, AS-36, AS-42)
- [X] T015 [P] Unit spec first, then code: `C/domain/vote-transition.spec.ts` (delta table `{dUps,dDowns,dWups,dWdowns}`; `fast-check` property: for any sequence of votes by any users derived counts equal the count of final records) → `C/domain/vote-transition.ts` (C5, AS-24)
- [X] T016 [P] Unit spec first, then code: `C/domain/vote-weight.spec.ts` (23 h 59 m → 0, 24 h → 1, shadow → 0, unresolved → 0) → `C/domain/vote-weight.ts`; `C/domain/anomaly.spec.ts` (threshold 10 zero-weight votes/10 min, window, once-per-hour dedupe) → `C/domain/anomaly.ts` (C7, AS-44, AS-48)
- [X] T017 Create `C/infra/scylla-store.ts` wrapper (explicit timeouts, maps timeout/unavailable to `service_unavailable`, no driver text in errors) and `C/infra/discussions-metrics.ts` (counters/histograms registered with `MetricsRegistry`) (G3, G4, AS-52, AS-54)
- [X] T018 Create `C/discussions-worker.module.ts` ownership: single owner of jobs and relay (no second `VoteService` provider); `C/discussions.module.ts` wires ports to adapters via tokens and imports the identity/catalog export modules (G7, D-8: add nothing infra to `index.ts`)
- [X] T019 Boot check (L-004, L-015): start the real `apps/core` and `apps/worker` once (or `scripts/qa/boot-check`) and confirm clean boot of `DiscussionsModule`/`DiscussionsWorkerModule` before moving on

**Checkpoint**: foundation ready.

---

## Phase 3: User Story 1 — Start a discussion on a product (P1) 🎯 MVP

**Goal**: idempotent, atomic post creation on a valid product board, with `get` and `delete`.
**Independent Test**: `test-spec.sh discussions-posts` green; `POST` twice with the same key → one `postId`.

### Tests (write first, must fail)

- [X] T020 [US1] Create `C/discussions-posts.e2e-spec.ts` (describe "Product discussions: boards, posts and idempotent create", HTTP via supertest, real modules, responses parsed with the contracts schemas, persisted rows asserted): AS-01 create post, AS-02 board validity (unknown, archived → `409 board_closed`, non-UUID, legacy `product-<uuid>`/`brand:*` → 400), AS-03 validation (one case per class: title length, trim, control/bidi characters, body, unknown field → `400 validation_failed`), AS-04 401 on every state-changing route, AS-41 get one post (`404 post_not_found`)
- [X] T021 [US1] Extend `discussions-posts.e2e-spec.ts`: AS-05 write rate limit → 429 with `RateLimit`, `RateLimit-Policy`, `Retry-After`, and `503 rate_limiter_unavailable` when limiter store down (frozen clock; S50 follow-up); AS-06 idempotency (replay returns stored status and body, different body → `422 idempotency_key_reuse`, missing → `422 idempotency_key_required`, in-flight → `409 request_in_progress`, 20 concurrent identical creates → one post, user scope, TTL)
- [X] T022 [US1] Extend `discussions-posts.e2e-spec.ts`: AS-47 delete post (author 204, moderator 204, other user 403 `forbidden`, unknown 404, repeat idempotent, comments unreachable after delete, `deleted_by` recorded, raw markdown erased) (A6, W02 B-4)

### Implementation

- [X] T023 [P] [US1] `C/api/discussions.dto.ts`: request DTOs with trim, code-point length, `whitelist` + `forbidNonWhitelisted`, board id `ParseUUIDPipe`, title rules from `content.ts` (A1, A5)
- [X] T024 [P] [US1] `C/infra/catalog-board-gate.adapter.ts` (only importer of `ProductQueryService.getProductsByIds`; 300 ms timeout; ACTIVE → ok, ARCHIVED → `board_closed`, missing → `board_not_found`) implementing `BoardGate` (A1, D-12)
- [X] T025 [P] [US1] `C/infra/scylla-post.store.ts`, `scylla-claim.store.ts`, `scylla-event.store.ts`: creation claim `INSERT … IF NOT EXISTS USING TTL 90000` (`create_claims`), one logged batch with `posts`, `posts_by_board`, `board_months`, `recorded_events`, `pending_events` rows, LWT delete `IF deleted = false` (A3, A4, G1, R-3, R-4)
- [X] T026 [US1] `C/application/post.service.ts`: create (gate → claim → batch → rank cache add), get, delete (author or `ADMIN`/`MODERATOR`; LWT applied result decides who records `discussion.post_deleted`); shadow content records no event; replaces `discussion.service.ts` post paths; no `FeedPublisher` call (A3, A4, A6, A7, FR-020)
- [X] T027 [US1] `C/api/discussions.controller.ts` post routes: `@Idempotent`, `@RateLimit('discussion.write')`, `POST /boards/:productId/posts`, `GET /posts/:postId`, `DELETE /posts/:postId`; `PostView` shape (`commentCount`, `score`, `myVote`); `X-Content-Type-Options: nosniff` (A7, F4)
- [X] T028 [P] [US1] `C/application/discussion-query.service.ts` `getPostsByIds` (≤ 100 ids else `RangeError`, one `IN` query, deleted and shadow absent, `PostSummaryDto`); export from `C/index.ts` barrel (FR-061, G2, S26 follow-up)
- [X] T029 [US1] Run `test-spec.sh discussions-posts` until green; start the real API again (L-004)

**Checkpoint**: US1 independently testable.

---

## Phase 4: User Story 2 — Nested comments and threads (P1)

**Goal**: atomic comment/reply creation, tombstone delete, paged thread with embedded replies and a replies endpoint.
**Independent Test**: `test-spec.sh discussions-comments` green.

### Tests (write first, must fail)

- [X] T030 [US2] Create `C/discussions-comments.e2e-spec.ts` (describe "Product discussions: nested comments, threads and tombstones"): AS-13 create comment and reply, AS-14 thread order for sorts old/new, AS-15 reply denials (other post, unknown, deleted parent `409 parent_deleted`, depth 8 → `422 max_depth_exceeded`, non-UUID), AS-16 comment denials (post gone, closed board, body, key)
- [X] T031 [US2] Extend: AS-17 comment idempotency (replay, concurrent identical ×20), AS-19 concurrent comments under a frozen clock give unique ordered IDs (×20), AS-18 partition spill at size 5 with replies staying with their root and bounded rows per page (row-read counter, `limit × 6`)
- [X] T032 [US2] Extend: AS-20 replies embedded (first 5 + `hasMoreReplies`) and `GET /comments/:commentId/replies` load more, cursor tampering → `invalid_cursor` (B-5), AS-21 author delete → tombstone (`authorId: null`, empty body, `deleted: true`, `deletedBy`), idempotent, counts decremented once, AS-22 delete authorization (other user 403, moderator ok, seller 403, unknown 404), AS-23 reply racing with parent delete (×20, one of the two allowed outcomes, no orphan, counts follow committed rows)

### Implementation

- [X] T033 [P] [US2] `C/infra/scylla-comment.store.ts`: `post_buckets` LWT slot allocator, logged batch (`comments_by_post`, `top_comments_by_post` for roots, `comment_locator`, `recent_posts`, recorded + pending event), LWT tombstone on row and root index row (B1, B2, FR-014)
- [X] T034 [P] [US2] `C/infra/scylla-count.store.ts` + `C/infra/redis-count.cache.ts`: `post_comment_counts`, `comment_reply_counts` counters incremented after batch commit, decremented once after delete LWT; Redis `dsc:ccnt:{postId}` 1 h rebuilt on miss (B6, FR-016)
- [X] T035 [US2] `C/application/comment.service.ts`: create (reply rules: depth ≤ 8, parent exists in same post, `parent_deleted`, board closed, shadow flag), delete (author/moderator, tombstone, event `discussion.comment_deleted`), thread read via `top_comments_by_post` + one 5-row range read per root, replies endpoint with `replies` cursor, `CommentView` (no `path`, `myVote`, `replyCount`, `deletedBy`) (B3–B7, FR-010–FR-016)
- [X] T036 [US2] Controller routes in `C/api/discussions.controller.ts`: `POST /posts/:postId/comments` (`@Idempotent`, `@RateLimit`), `GET /posts/:postId/comments`, `GET /comments/:commentId/replies`, `DELETE /comments/:commentId`; query DTOs for `sort=best|new|old`, `limit`, `cursor` (B4, D6)
- [X] T037 [US2] Run `test-spec.sh discussions-comments` until green; boot real API (L-004)

---

## Phase 5: User Story 3 — Vote on posts and comments (P1)

**Goal**: one vote per user by compare-and-set, exact counts under concurrency, rate limits.
**Independent Test**: `test-spec.sh discussions-votes` green; 100 concurrent voters count exactly 100.

### Tests (write first, must fail)

- [X] T038 [US3] Create `C/discussions-votes.e2e-spec.ts` (describe "Product discussions: votes, concurrency and rate limits"): AS-24 vote, flip, retract on post and comment, AS-25 replay and no-op retract (full six-field `VoteResult`), AS-26 validation, unknown target `404 target_not_found`, client `targetType` refused, AS-27 self-vote `422 self_vote_not_allowed`, AS-28 vote on deleted targets `409 target_deleted`, AS-32 `myVote` for signed-in vs anonymous
- [X] T039 [US3] Extend: AS-29 100 concurrent voters count exactly 100 (and still 100 after flushing Redis), AS-30 same-user concurrent +1/−1 race (×20: 200 or `409 vote_in_progress` + `Retry-After`, one record, counts equal records), AS-31 vote rate limit → 429 with headers (frozen clock)

### Implementation

- [X] T040 [P] [US3] `C/infra/scylla-vote.store.ts`: CAS on `votes_by_target` (`version`, `weight`, `cast_at`, `target_type`), ≤ 2 attempts, retraction deletes the row; stop writing `votes_by_user` (C3, C8, R-1)
- [X] T041 [P] [US3] `C/infra/redis-count.cache.ts` additions: `dsc:cnt:{targetId}` hash with `ups, downs, wups, wdowns`, 1 h TTL, rebuilt from `votes_by_target` on miss; live counts follow the committed `(previous, new)` pair; durable delta through `WriteBehindCounter` in the same Lua/multi step so a crash cannot lose it (C4, C5)
- [X] T042 [US3] `C/application/vote.service.ts` rewrite: server resolves `targetType` via `comment_locator`/posts (C1), self-vote and deleted checks (C2), weight from `vote-weight.ts` (fixed at cast time, C7), anomaly hook (`recent_targets`), `VoteResult` always complete (C6); cache down → `503 service_unavailable` (AS-51); remove the Redis lock (C3)
- [X] T043 [US3] Controller `PUT /votes/:targetId` with `VoteRequest {value}` and `@RateLimit('discussion.vote')`; `skipThrottle` removed; flush job in `C/infra/discussions.jobs.ts` flushes buffered deltas (F3, G7)
- [X] T044 [US3] Run `test-spec.sh discussions-votes` until green; boot real API (L-004)

---

## Phase 6: User Story 7 — Safe user content (P1)

**Goal**: raw markdown kept, sanitised rendition versioned and re-rendered on read.
**Independent Test**: `test-spec.sh discussions-markdown` green.

- [X] T045 [US7] Create `C/discussions-markdown.e2e-spec.ts` (describe "Product discussions: safe markdown over HTTP"): AS-08 one wired post with the allow-list (tags, attributes, link `rel`/`target`, headings), AS-09 whole XSS corpus posted once as posts and comments (stored raw markdown unchanged, output has no executable construct), AS-10 old `html_version` row re-rendered on read (seed an old rendition at the store edge), AS-11 title verbatim, JSON content type, `nosniff` on these routes (E5), AS-12 over-limit body → `400 validation_failed`/`markdown_too_complex`, one max-size body renders in time
- [X] T046 [US7] Wire `content.ts` into `post.service.ts` and `comment.service.ts`: store `body_md` raw + `body_html` + `html_version`; re-render on read when the stored version is older than `HTML_POLICY_VERSION`, lazy refresh of the stored rendition, shadow items and tombstones excluded (E1, R-10, FR-041)
- [X] T047 [US7] Run `test-spec.sh discussions-markdown` until green

---

## Phase 7: User Story 4 — Browse a board: hot, top, new (P2)

**Goal**: keyset-paged hot/top/new lists from capped, TTL'd rankings, with degraded fallback.
**Independent Test**: `test-spec.sh discussions-ranking` (AS-33–AS-40) green.

### Tests (write first, must fail)

- [X] T048 [US4] Create `C/discussions-ranking.e2e-spec.ts` (describe "Product discussions: hot, top, new, best, paging and cache"): AS-33 hot order (votes vs age) and new order, AS-34 hot formula tie stable order, AS-35 paging through hot/top/new with a vote moving a post across the cursor (no repeat, no skip), AS-36 top windows with inclusive boundary and ties, AS-37 new across month boundaries, 30 months back, empty board, AS-38 ranking cap (cap 3), AS-39 invalid `sort`/`window`/`limit`/`cursor` → 400 and defaults, AS-40 empty and unknown board, deleted post absent; anonymous GET not `skipThrottle`d (F3)

### Implementation

- [X] T049 [P] [US4] `C/infra/redis-ranking.cache.ts` + `C/infra/rank-scripts.ts`: `dsc:rank:{boardId}:hot` and `:top:{window}` ZSETs (member `sortableId(postId)`, TTL 6 h refreshed on write, trimmed to cap), Lua page script ordered by score then newest `postId`, rebuild on miss from stores (scan cap 20,000) (D1, D2, D3, FR-030–FR-035)
- [X] T050 [US4] `C/application/board-query.service.ts`: `hot/top` via rank cache and HMAC keyset cursor, `new` via `board_months` walk (no horizon, D5), batched hydration (one `IN` read + one counts pipeline, D7), weighted inputs for ranking, raw counts for display (D10), `degraded: true` from newest 200 when Redis down (D9)
- [X] T051 [US4] Controller `GET /boards/:productId/posts?sort&window&limit&cursor` with strict query DTO: `sort` ∈ `hot|top|new`, `window` ∈ `day|week|month|year|all` only with `top`, `limit` 1–50 default 25, nothing falls back (D6); response `{items, nextCursor, degraded?}`
- [X] T052 [US4] Run `test-spec.sh discussions-ranking -t "AS-3[3-9]|AS-40"` until green

---

## Phase 8: User Story 5 — Best comments and cheap hot threads (P2)

**Goal**: `best` comment order by Wilson bound and a 5 s viewer-independent first-page cache.
**Independent Test**: AS-42, AS-43 in `discussions-ranking.e2e-spec.ts`.

- [X] T053 [US5] Extend `discussions-ranking.e2e-spec.ts`: AS-42 best order with Wilson table, ties older first; AS-43 first-page cache (write invalidates; vote lag ≤ 5 s with clock +4 s / +6 s; cache key inspection: TTL 5 s, no `myVote`, no shadow items)
- [X] T054 [P] [US5] `C/infra/redis-page.cache.ts`: `dsc:page:{postId}:{sort}` JSON, 5 s, deleted by every thread write; `dsc:rank:{postId}:best` ZSET (6 h) maintained on comment create/vote (D8, FR-036)
- [X] T055 [US5] Integrate `best` ordering and the page cache into `comment.service.ts` thread read; degraded: newest 200 top-level comments with `degraded: true` when Redis is down (D9)
- [X] T056 [US5] Run `test-spec.sh discussions-ranking` (whole file) until green

---

## Phase 9: User Story 6 — Abuse controls and moderation (P2)

**Goal**: shadow bans, weighted votes, anomaly signal, single-owner rate-limit profiles.
**Independent Test**: `test-spec.sh discussions-abuse` green.

- [X] T057 [US6] Create `C/discussions-abuse.e2e-spec.ts` (describe "Product discussions: abuse controls and moderation"): AS-44 new-account weight (ranking unchanged, display raw, fixed at cast time, account age through identity `createdAt`), AS-45 user directory faulted → weight 0, AS-46 shadow ban set/lift, visibility to author only, authorization (`403 forbidden` for non-moderator), unknown user `404 user_not_found`, AS-48 anomaly signal event once per hour per target
- [X] T058 [P] [US6] `C/infra/scylla-shadow.store.ts` + `C/infra/identity-account-directory.adapter.ts` (only importer of `UserDirectoryService.getUsersByIds`; 300 ms timeout; failure/unknown → weight 0; 60 s local shadow-ban cache) (F1, C7)
- [X] T059 [US6] `C/application/moderation.service.ts` + `C/api/moderation.controller.ts`: `PUT/DELETE /moderation/shadow-bans/:userId` with `Firewall({roles: ['ADMIN','MODERATOR']})` (F1); post/comment services flag `shadow` at write, readers hide shadow content from others, no events for shadow content
- [X] T060 [US6] Anomaly detection in `vote.service.ts` with `dsc:anom:*`/`dsc:anomsent:*`, event `discussion.vote_anomaly_detected` through the recorded-event path (C7)
- [X] T061 [US6] Rate-limit ownership (F2): keep `discussion.write`/`discussion.vote` in `C/rate-limit-policies.ts` (`definePolicies`/`forFeature`); note in `gaps.md` "Sibling-spec follow-ups" that media (`media.controller.ts:28`) and share links (`share-links.controller.ts:21`) must adopt their own profiles (S29, S37, S50); do not edit those files
- [X] T062 [US6] Run `test-spec.sh discussions-abuse` until green

---

## Phase 10: User Story 8 — Dependable under failure and storms (P3)

**Goal**: derived state recoverable, events relayed at least once, errors never leak internals.
**Independent Test**: `test-spec.sh discussions-resilience` green.

- [X] T063 [US8] Create `C/discussions-resilience.e2e-spec.ts` (describe "Product discussions: derived-state recovery, outages and observability"): AS-07 event recorded with the write, bus down then relayed once, shadow posts record none, relay duplicate delivery (same `eventId` twice → one effect), invalid recorded event → `dead_events`, no side effect; AS-49 ranking cache emptied → counts and orders identical, every `dsc:*` key has a TTL; AS-50 injected drift repaired by `discussions.reconcile` run through the jobs service; AS-51 cache down → degraded reads, votes 503, creates continue; AS-52 store timeout → generic 5xx without internals, retry with same key succeeds, one post; AS-53 problem+json on 5xx, 401, unknown route; AS-54 captured log scan (requestId present, no bodies, metrics emitted); AS-55 ID order equals creation order and GET never changes state
- [X] T064 [P] [US8] `C/application/event-relay.service.ts`: read `pending_events` shards → `EventPublisher` with stable `eventId` → delete on success; unknown/invalid → `dead_events`; no `groupId` on a standard queue (L-001; validate options where the message is created) (G1, R-3)
- [X] T065 [P] [US8] `C/application/reconcile.service.ts`: recount targets from `recent_targets`/`recent_posts` against `votes_by_target`/comment rows, repair counters and ranking, within 15 min; `discussions.recount` and one-shot `discussions.backfill` (idempotent upserts of `board_months` and `top_comments_by_post` from old rows) (C4, C5, FR-024)
- [X] T066 [US8] Schedules in `C/infra/discussions.jobs.ts` registered only by `DiscussionsWorkerModule`: flush (5 s), relay, reconcile (5 min), recount, backfill (S49); queues named exist in `elasticmq.conf` if any are used (L-002) (G7)
- [X] T067 [US8] Timeouts and 503 mapping everywhere via `scylla-store.ts`/Redis wrappers; structured logs with `requestId`, no bodies; metrics per `discussions-metrics.ts` (G3, G4, AS-52, AS-54)
- [X] T068 [US8] Run `test-spec.sh discussions-resilience` until green; boot real `core` and `worker`, run quickstart smoke steps 1–5 (L-004, L-015); damage tests clean up what they broke (L-013)

---

## Phase 11: Callers, cleanup, debt

- [X] T069 [P] S48 follow-up: replace `boardPostsPageSchema` in `CT/bff/upstream.ts` with a re-export of `postPageSchema` keeping exported name and type name `BoardPostsPage`; adapt BFF fixtures in `packages/backend/libs/composition/bff/testing/fixtures.ts` to the real `PostView` (`postId`, not `id`); run `test-spec.sh libs/composition/bff`
- [X] T070 Rewrite `C/discussions-contracts.spec.ts` against the new schemas; delete `C/discussions.e2e-spec.ts` and `C/application/discussion.service.ts` once replacements pass; keep `feed-publisher.service.ts` and all `feed.*`/projector files untouched (S26: D-7, D-8, D-12); `C/index.ts` adds only `DiscussionQueryService` (G8, D-6)
- [X] T071 [P] Add `scripts/load-tests/discussions.test.js` (k6: 10,000 votes/s plus board and thread reads; invariant final count = distinct voters; p99 read < 50 ms, vote < 30 ms) and `pnpm loadtest:discussions` script; seed script `scripts/load-tests/seed/` for 50,000-comment thread (SC-002, SC-003, SC-005; ops artifacts, not run)

---

## Phase 12: Polish, gates and documentation

- [X] T072 Write `docs/spec/capabilities/S25-discussions.md` (rules and behaviors first, `[proof: …]` for each e2e/unit row, `[code: …]` anchors); run `python3 scripts/livespec/check.py` until clean; create/edit no `*.reviewed.json` (rule 0)
- [X] T073 Update `gaps.md`: add `## Sibling-spec follow-ups` (S26 consume `discussion.post_created/post_deleted` + `getPostsByIds`, S28 switch import to `CT/community/events.ts`, S48 done, W02: `Idempotency-Key`, product-UUID board id, `{items,nextCursor}`, `{value}` votes, re-sanitise `bodyHtml`, de-dupe by `postId`, titles as text; S29/S37/S50 rate-limit profiles; S50 structured headers) and `## Spec changes` (nothing human-signed changed, or list it)
- [X] T074 Verify Ops artifacts: SC-001, SC-002, SC-003, SC-005 listed under "Ops artifacts" in `quickstart.md` and as rows in `specs/UNVERIFIED.md` with status "not run" (already present at plan time; confirm, never mark verified); SC-004, SC-006, SC-007, SC-008 map to AS-09/AS-10, AS-44/AS-46, AS-49, AS-52/AS-53 tests
- [X] T075 Static gates from `packages/backend`: `pnpm exec tsc --noEmit` (backend and contracts), ESLint, `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict` (no community line from S25; S26 projector lines remain), `pnpm check:module-graph`, `pnpm check:model-registry`; confirm direct `sequelize.transaction` count in community stays 0
- [X] T076 Run the whole capability suite once in batches of fresh processes (L-008): `libs/domains/community/domain`, then each `discussions-*` e2e file, then `libs/domains/community/feed` (S26 still green); a batch without its summary line is a crash, rerun it
- [X] T077 Fresh-stack verification (L-012): run `/opt/sdd/repo/scripts/qa/fresh-run.sh --here`; if the harness blocks it for the agent, write that into `questions.md` as needs-human and do not claim it passed
- [X] T078 Final report: mention each follow-up (S05 no catalog consumption, S28 names confirmed, S48 schema swap, S50 policies/headers, W02 B-4/B-5)

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks all) → US1 → US2 (needs post store/service) → US3 (needs targets from US1/US2) → US7 (needs creates) → US4 (needs posts, votes) → US5 (needs comments, votes, ranking cache) → US6 (needs votes, creates) → US8 (needs all writers) → Phases 11–12.
- Within a story: e2e test tasks (failing) → adapters/stores → service → controller → run.
- US1/US2/US3 can overlap after Phase 2 only on distinct stores; the shared `discussions.controller.ts` serialises controller tasks (T027, T036, T043, T051).

## Parallel opportunities

- Phase 2 unit-spec/code pairs T010–T016 and contracts T005–T007, fixtures T009 are all `[P]`.
- US1: T023, T024, T025, T028. US2: T033, T034. US3: T040, T041. US6: T058. US8: T064, T065. Phase 11: T069, T071.

## Implementation Strategy

- **MVP = Phase 1–3 (US1)**: posts, idempotent create, get, delete, query export, event recorded. Then US2 → US3 → US7 (P1 stories), then US4/US5/US6 (P2), US8 (P3), gates.
- Never leave a story without booting the real app (L-004/L-015) and running its narrowest spec.

## Notes

- Test-plan coverage: all 55 scenarios AS-01–AS-55 have an e2e task (T020–T022 AS-01–06, 41, 47; T063 AS-07, 49–55; T045 AS-08–12; T030–T032 AS-13–23; T038–T039 AS-24–32; T048/T053 AS-33–43; T057 AS-44–46, 48); unit tables in T010–T016.
- Gaps coverage: A1–A7 (T023–T027), B1–B7 (T011, T033–T036), C1–C8 (T040–T043), D1–D10 (T049–T051, T054–T055), E1–E5 (T013, T045–T046), F1–F4 (T007, T059, T061, T051), G1–G8 (T006, T028, T017, T064–T067, T005, T008, T018, T070); debt D-6 (T008), D-7/D-8/D-12 untouched (S26).

---

## Phase 13: Convergence

- [X] T079 Make `DISCUSSIONS_CURSOR_SECRET` mandatory in production: `packages/backend/libs/common/config/discussions-config.ts` falls back to the public `dev-only-discussions-cursor-secret` whenever the variable is empty, so in production the HMAC on keyset cursors can be forged and AS-39 (tampered cursor → `400 invalid_cursor`) is void; keep the development default only outside production (as `config-rules.spec.ts` does for other secrets) and add a config unit case per AS-39 (partial)
