# Implementation Plan: S25 — Product discussions (domain `community`)

**Branch**: `S25-discussions` (working branch `sdd/auto`) | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-55, FR-001–FR-074), `test-plan.md`, `gaps.md` (A1–G8, D-6/D-7/D-8/D-12, ownership lines), `questions.md` (defaults accepted as written), the constitution, and the follow-ups left by S05, S28, S48, S50 and W02 (below).

## Summary

Rebuild the discussions slice of `community` so that every write is atomic and idempotent, every count and ranking is derived state that can be lost and rebuilt, and every list is a keyset page:

1. **Writes** (`apps/core`): `POST` post/comment = `@Idempotent` (platform V.6 semantics) + a Scylla creation claim (the crash window) + one **logged batch** that holds the entity, its index rows and the **recorded event** (R-3, R-4). Votes = a compare-and-set LWT on `votes_by_target` (R-1); the live counts follow the committed `(previous, new)` pair.
2. **Reads** (`apps/core`): board `hot/top` from capped, TTL'd Redis ZSETs paged by an HMAC'd keyset cursor; `new` from `posts_by_board` walking `board_months`; threads from `top_comments_by_post` (roots) plus one 5-row range read per root; all hydrated in batches (R-6, R-7). Safe markdown re-rendered on read when the stored policy version is old (R-10). Redis down → `degraded: true` from the newest 200 (R-7).
3. **Background** (`apps/worker`, `DiscussionsWorkerModule` is the single owner): event relay, vote flush, reconciliation, recount, backfill (R-3, R-9).
4. **Moderation/abuse**: shadow bans, moderator deletes, weighted votes, anomaly signal (R-8).

Why not the infrastructure outbox: it is a PostgreSQL table written in a SQL transaction; `community` owns no PostgreSQL table (D5), so using it would be the dual write IV.4 forbids. A Scylla logged batch plus a relay table is the same pattern inside the owning store (research R-3).

## Technical Context

**Language/Version**: TypeScript (strict), NestJS 11 modules, Zod 4 schemas in `packages/contracts`
**Primary Dependencies**: `cassandra-driver` through `CassandraService.client` (logged batches, LWT, `IN` on partition key), `RedisService` (ioredis, Lua), `WriteBehindCounter` and `CacheModule` single flight (S52), `@app/infrastructure/idempotency` (`@Idempotent`), `@app/infrastructure/events` (`defineEvent`, `EventPublisher`), `@app/infrastructure/jobs` (S49 schedules), `@app/infrastructure/rate-limit` (S50), `marked` + `sanitize-html`, `UserDirectoryService` (S01 R1), `ProductQueryService` (S05 R1), `CLOCK`, `MetricsRegistry`, `fast-check` (unit property test)
**Storage**: ScyllaDB (durable, `community`-owned tables, `060_discussions_s25.cql`); Redis `dsc:*` (derived, every key with a TTL); no PostgreSQL table; platform idempotency record in PostgreSQL (infrastructure-owned)
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (seven `discussions-*.e2e-spec.ts` files of `test-plan.md`), unit specs beside `domain/`, one W02 Playwright journey (not owned here)
**Target Platform**: Linux; `apps/core` (HTTP), `apps/worker` (jobs, relay)
**Project Type**: backend domain module + contracts package; web owned by W02, BFF by S48
**Performance Goals**: board/thread reads 50,000 rps p99 < 50 ms, vote p99 < 30 ms (SC-003, ops artifact); per-page store reads bounded (`limit × 6` rows, AS-18)
**Constraints**: write budget 2 s end to end; Scylla read 800 ms, write 1,500 ms, Redis 150 ms, directory lookup 300 ms, catalog lookup 300 ms; retries only in the vote CAS loop (≤ 2 attempts); page size default 25, max 50
**Scale/Scope**: threads of 50,000 comments, boards of 1,000-post rankings (rebuild scan cap 20,000 posts), 10,000 votes/s fleet-wide

**Connection arithmetic (III.12)**: no PostgreSQL connection is opened by `community` code (the platform idempotency record uses the shared pool already sized for the routes that use it); Scylla uses the shared driver pool (2 connections per host); Redis the shared client.

## Constitution Check

| Gate | Status | How |
|---|---|---|
| 1 Layers (I.1–I.3) | PASS after work (D-6, B7) | ports + tokens in `domain/`; `application/` imports no `infra/` (G6); `domain/` has no `node:crypto`, `Date.now()` or `new Date()` (ids, paths take `now`/`RandomSource`) |
| 2 Pipeline (II) | PASS after work | thin controllers; query DTOs validate `sort/window/limit/cursor`; domain errors with `code` rendered by the global filter; role check by `Firewall({roles})` for shadow bans, record-level author/moderator check in the application service |
| 3 Data access (III.1–III.12) | PASS after work | only `infra/` stores touch Scylla/Redis; no network I/O inside a SQL transaction (none opened); invariants by LWT (vote CAS, delete once, claim, slot allocator), not check-then-write; caches have TTLs, `SCAN`/`KEYS` unused; keyset cursors; additive CQL only; `.tx.baseline` = 0, no `sequelize.transaction` touched or added |
| 4 Messaging (IV.4–IV.8) | PASS after work | events recorded in the same logged batch, relayed at least once with a stable `eventId`; invalid recorded events go to `dead_events`; explicit timeouts everywhere; identity/catalog reached through R1 ports (ACL adapters) |
| 5 Contracts (V) | PASS after work | schemas for every request/response in `packages/contracts`; problem+json with stable `code`; `Idempotency-Key` on both creates; `GET` changes no state; breaking shapes listed in `contracts/discussions-api.md` |
| 6 Frontend (VI) | N/A here | W02 owns the board components (VI.3, VI.7 gaps listed under follow-ups) |
| 7 Tests (VII) | PASS after work | all 55 scenarios mapped in `test-plan.md`; every fallback forced (AS-07, AS-45, AS-49, AS-50, AS-51, AS-52); concurrency by `Promise.all` ×20; responses parsed with the contracts schemas |
| 8 Operations (VIII) | PASS after work | structured logs with `requestId`, no bodies (AS-54); metrics; jobs scheduled once per tick by S49; config validated at startup (new keys in joi schema) |
| 9 DB isolation (IX) | PASS after work | zero community lines from S25 in `check:table-ownership --strict`; the projector lines (D-7, D-8, D-12) belong to S26 |
| 10 Monorepo (X) | PASS after work | barrel adds `DiscussionQueryService` only; no new infra export (D-8 not worsened); modules imported by `apps/*` unchanged |

Post-design re-check: still PASS. Risks: (a) the topic registry must know aggregate type `discussion` (first relay task checks it, adds the registration if absent); (b) a logged batch across partitions costs ~2× a single write: accepted, creation is rate-limited to 10/min/user; (c) rebuilding a ranking on a board over the scan cap ranks only its newest 20,000 posts after a cache loss (documented, configurable); (d) the 60 s local shadow-ban cache lets a fresh ban miss for up to 60 s on other instances (content created in that window is not flagged; ban is prospective by spec).

## Follow-ups from built sibling specs (treated as requirements)

1. **S05 → S25** (`catalog.product_*` full-state events): S25 never reads `Product`. The only catalog fact it needs (ACTIVE/ARCHIVED, existence) is read on writes through R1 `ProductQueryService.getProductsByIds` as `spec.md` states, behind the `BoardGate` port. No projection, no event consumer. Recorded in `research.md` R-13; if the BFF/ops later wants a read-path gate, the port is where the compacted `products` topic would be consumed.
2. **S28 → S25** (topic names and payloads): `contracts/events.md` confirms the `discussion.comment_created` fields S28 consumes; the schemas ship in `packages/contracts/src/community/events.ts` (task T40).
3. **S48 → S25** (own schema for the board posts page): replace `boardPostsPageSchema` in `packages/contracts/src/bff/upstream.ts` with a re-export of `postPageSchema` (same exported name and type name `BoardPostsPage`); the BFF fixtures (`libs/composition/bff/testing/fixtures.ts`) are adapted to the real `PostView` shape (`postId`, not `id`; note the upstream placeholder required `id`) so `bff.e2e-spec.ts` keeps parsing (task T41).
4. **S50 → S25**: policies stay in `rate-limit-policies.ts` (`definePolicies`/`forFeature`); controllers use `@RateLimit`; anonymous GETs lose `skipThrottle`; contracts and e2e adopt `RateLimit`/`RateLimit-Policy` headers and `503 rate_limiter_unavailable` (T36). The other owners of `discussion.write` (media, share links) are listed in `gaps.md` "Sibling-spec follow-ups".
5. **W02 → S25** (B-4, B-5): `DELETE /posts/:postId` (T22) and `GET /comments/:commentId/replies` (T27) are in the plan with e2e rows AS-47 and AS-20.
6. **S54 toolkit**: community opens no transaction (`.tx.baseline` is 0); nothing to migrate, nothing to add.
7. **gaps.md items**: every row A1–A7, B1–B7, C1–C8, D1–D10, E1–E5, F1–F4, G1–G8 and the debt rows D-6 (paid), D-7/D-8/D-12 (S26, untouched) are in the tasks below.
8. **Living specification**: `docs/spec/capabilities/` has no page for S25 (and none for S26), so rule (0) has nothing to edit first; the implementation adds `docs/spec/capabilities/S25-discussions.md` with `[proof: ...]`/`[code: ...]` anchors in the final task, validated with `python3 scripts/livespec/check.py`. No `*.reviewed.json` is created or edited and nothing signed by a human changes (`gaps.md` "Spec changes").

## Project Structure

### Documentation

```text
specs/domains/S25-discussions/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/discussions-api.md  contracts/events.md
└── tasks.md   # /speckit-tasks
```

### Source code (`packages/backend/libs/domains/community/`; contracts in `packages/contracts/src/community/`; CQL in `packages/backend/cql/`)

```text
packages/backend/cql/060_discussions_s25.cql          # additive columns + tables of data-model.md (expand only)
packages/contracts/src/community/discussions.ts       # extend: request schemas, error codes, window/sort enums (T40)
packages/contracts/src/community/events.ts            # defineEvent schemas for the five events (T40)
packages/contracts/src/bff/upstream.ts                # boardPostsPageSchema = re-export of postPageSchema (T41)
packages/backend/libs/common/config/…                 # discussions config keys (caps, TTLs, partition size, timeouts), joi-validated
community/
├── api/
│   ├── discussions.controller.ts                     # boards/posts/comments/replies/votes; thin, @Idempotent, @RateLimit
│   ├── moderation.controller.ts                      # shadow bans (Firewall roles ADMIN, MODERATOR)
│   └── discussions.dto.ts                            # request + query DTOs (trim, code-point length, whitelist)
├── application/
│   ├── post.service.ts                               # create/get/delete post, board gate, claim, batch, events
│   ├── comment.service.ts                            # create/delete/read thread, replies, tombstones
│   ├── board-query.service.ts                        # lists hot/top/new, cursors, hydration, degraded
│   ├── vote.service.ts                               # CAS vote, weights, count apply, anomaly
│   ├── moderation.service.ts                         # shadow ban set/lift
│   ├── reconcile.service.ts                          # recount + repair + rank recompute (job body)
│   ├── event-relay.service.ts                        # pending → EventPublisher → delete (job body)
│   └── discussion-query.service.ts                   # R1 export getPostsByIds
├── domain/
│   ├── ports.ts + tokens                             # stores, caches, directory, board gate, clock (D-6)
│   ├── ids.ts                                        # timeuuid from clock, sortableId, comparator (R-5)
│   ├── paths.ts                                      # path segments from now, depth, bucket assignment rules
│   ├── ranking.ts                                    # hotScore, wilson (exists), topWindow start
│   ├── top-window.ts  vote-weight.ts  vote-transition.ts  anomaly.ts  cursor.ts
│   ├── content.ts                                    # render + policy version + complexity gate + title rules
│   ├── discussion-errors.ts                          # DomainError(code, status)
│   └── *.spec.ts                                     # table-driven unit specs of test-plan.md
├── infra/
│   ├── scylla-*.store.ts                             # post, comment, vote, claim, event, shadow stores; ScyllaStore wrapper (timeouts)
│   ├── redis-ranking.cache.ts  redis-count.cache.ts  redis-page.cache.ts  rank-scripts.ts
│   ├── identity-account-directory.adapter.ts  catalog-board-gate.adapter.ts   # ACL (IV.8), only importers of R1 services
│   ├── discussions.jobs.ts                           # flush, relay, reconcile, recount, backfill schedules
│   └── discussions-metrics.ts
├── discussions.module.ts  discussions-worker.module.ts  index.ts   # barrel: + DiscussionQueryService; no infra classes (D-8)
├── discussions-{posts,comments,votes,ranking,markdown,abuse,resilience}.e2e-spec.ts   # replace discussions.e2e-spec.ts
└── discussions.fixtures.ts                           # users/products via shared helpers, fault-injecting store wrappers, frozen clock
docs/spec/capabilities/S25-discussions.md             # living page (last task)
scripts/load-tests/discussions.test.js                # ops artifact (SC-002, SC-003)
```

`discussions-contracts.spec.ts` (shape check of the old API) is rewritten against the new schemas; `feed.*` files are not touched (S26). The old `discussion.service.ts` is deleted once its replacements pass; `application/feed-publisher.service.ts` stays for S26 (unreferenced by S25).

**Structure Decision**: stay inside `community` (no new deployable, I.6). Splitting the 400-line `DiscussionService` into per-use-case services keeps each file reviewable; ports make the Scylla/Redis adapters swappable for the fault-injecting wrappers the tests need.

## Technical tasks by gap (input for `/speckit-tasks`)

Order is test-first within each step; the whole suite runs once at the end (L-008: batches of fresh processes).

1. **Contracts, config, schema (T01–T06)**: `060_discussions_s25.cql`; contracts schemas and event definitions (G5, FR-073); config keys + joi; error family `DomainError` with the code list (F4, FR-070); ports and tokens (G6/D-6); metrics registry (G4). Start-up check: boot the real `core` and `worker` apps (L-004, L-015).
2. **Pure logic with unit specs (T10–T19)**: `ids.ts` (A3 order, B7, R-5), `paths.ts` clockless (B7), `content.ts` v2 (E1, E2, E3, E4 corpus, title rules A5), `ranking.ts` additions + `top-window.ts` (D4), `vote-weight.ts` (C7), `vote-transition.ts` (+ fast-check, C5), `anomaly.ts` (C7), `cursor.ts` (D1, tamper), `thread-position`/depth rules (B3).
3. **Posts (T20–T26)**: DTO validation (A5, A1), board gate adapter (A1), claim + logged batch + event row (A2, A3, A4, G1), idempotent controller, `GET post`, `DELETE post` (A6, W02 B-4), `PostView` (A7); `discussions-posts.e2e-spec.ts` (AS-01–AS-06, AS-41, AS-47); `DiscussionQueryService` (G2).
4. **Comments (T27–T33)**: root slot allocator and batch (B1, B2), reply rules (B3), replyCount/commentCount counters (B6, FR-016), tombstone delete with moderator path (B5, B6), thread read with `top_comments_by_post` and embedded replies, `replies` endpoint (B4, W02 B-5), `CommentView` (B5); `discussions-comments.e2e-spec.ts` (AS-13–AS-23).
5. **Votes (T34–T38)**: target resolution by server (C1), self/deleted checks (C2), CAS store and counts (C3, C5, C6), live/durable counters with rebuild (C4), weights and anomaly (C7), drop `votes_by_user` from the write path (C8); rate-limit headers (S50, F3); `discussions-votes.e2e-spec.ts` (AS-24–AS-32).
6. **Ranking (T39–T44)**: Redis rank cache + Lua page script (D1, D2, D3), `top` windows (D4), `new` via `board_months` (D5), strict query DTOs (D6), batched hydration (D7), first-page cache (D8), degraded path (D9); `discussions-ranking.e2e-spec.ts` (AS-33–AS-43).
7. **Abuse and safe markdown (T45–T48)**: moderation controller and shadow store (F1), weights from shadow/age, E5 nosniff test, markdown re-render on read with lazy refresh (E1); `discussions-abuse.e2e-spec.ts` (AS-44–AS-48), `discussions-markdown.e2e-spec.ts` (AS-08–AS-12).
8. **Resilience and operations (T49–T53)**: event relay job with dead letters, reconcile job, backfill job, schedules in the worker module only (G7), timeouts and 503 mapping (G3), logging/metrics (G4); `discussions-resilience.e2e-spec.ts` (AS-07, AS-49–AS-55).
9. **Callers and cleanup (T54–T57)**: S48 schema swap and BFF fixtures (T41), `index.ts`, remove the old service and e2e, `feed-publisher` untouched, D-8 not worsened.
10. **Gates (T58–T60)**: `tsc`, ESLint, `pnpm check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`; `scripts/livespec/check.py` with the new page; whole capability suite once; `scripts/qa/fresh-run.sh`; ops artifacts into `specs/UNVERIFIED.md` (done at plan time); k6 script.

## Complexity Tracking

| Violation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Relay table in Scylla instead of the infrastructure outbox | `community` owns no PostgreSQL table (D5); the outbox is SQL | A SQL outbox row beside a Scylla write is a dual write (IV.4) |
| Two idempotency layers (platform record + Scylla claim) | The platform record cannot cover a crash after the Scylla commit or AS-52 | Platform record alone duplicates posts when the response is lost |
| LWT-heavy vote path | One-vote-per-user must be a store invariant (III.6) and survive a Redis lock expiry | Redis lock + read-then-write is the defect C3 |
| `top_comments_by_post` duplicates root rows | Bounded page reads (`limit × 6` rows) | Reading whole partitions and filtering roots breaks SC-005 |
