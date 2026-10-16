# Implementation Plan: S26 — Follow graph and home feed (domain `community`)

**Branch**: `S26-follow-feed` (working branch `sdd/auto`) | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-51, FR-001–FR-052, SC-001–SC-010), `test-plan.md`, `gaps.md` (A1–A9, B1–B8, C1–C6, D1–D7, E1–E5, debt D-6/D-7/D-8/D-12, ownership lines), `questions.md` (defaults accepted as written; no line edited by a human), the constitution, and the follow-ups left by S05, S28, S29, S49 and S50 (below).

## Summary

Rebuild the follow/feed slice of `community` so that every relation, count and item has a durable truth and every Redis structure is a rebuildable cache with a TTL:

1. **Follow graph** (`apps/core`): conditional write on the buyer-side row decides (LWT with a per-relation sequence `rel_ts`); the other direction and the list index are written with `USING TIMESTAMP rel_ts` so they converge in any order (R-1); the limit is a reservation CAS (R-2); counts are moved only by the request whose conditional write applied; a daily reconciliation repairs drift (R-9). Targets are validated through S03/S01 R1 services.
2. **Items from events** (`apps/projector`): four projector consumers (`products.events`, `discussion.events`, `auctions.events`, `feed.events`) on the S53 framework, idempotent by version guard / claim rows, schema-validated, dead-lettering; the product copy is a `community`-owned store (R3), replacing the `Product` read (D-7, D-12). One item per `(kind, source)` by an `IF NOT EXISTS` claim (R-4). The item, its history row and its announcement are one logged batch; a relay job publishes `feed.item_published` at least once (R-5).
3. **Fan-out** (`apps/projector`): per-author ordered consumer; active-only pipelined pushes into a ZSET timeline ordered by `(ms, sortableId)`; celebrity authors never pushed, their recents merged at read time; status durable and sticky (R-3, R-7).
4. **Read** (`apps/core`): keyset-paged merge of pushed timeline, celebrity recents and pull continuation; rebuild on return that never loses a concurrent push (`ZUNIONSTORE`, completion marker); batched hydration with fail-closed visibility; degraded modes (R-8).

Why not the infrastructure outbox / `inbox`: both are PostgreSQL tables written in a SQL transaction; `community` owns no PostgreSQL table (D5), so using them would be the dual write IV.4 forbids. Same reasoning and the same Scylla pattern as S25 (research R-5, R-6).

## Technical Context

**Language/Version**: TypeScript (strict), NestJS 11 modules, Zod 4 schemas in `packages/contracts`
**Primary Dependencies**: `cassandra-driver` via `CassandraService` (LWT, logged batches, `USING TIMESTAMP`, `IN` on partition key), `RedisService` (ioredis, pipelines, Lua), `@app/infrastructure/projections` (`Projector`, `SinkBackpressureError`, transient/permanent errors), `@app/infrastructure/events` (`defineEvent`, `EventPublisher`, `EventsModule.forAggregates`), `@app/infrastructure/jobs` (S49: `JobsService`, `declareJobType`, `@JobHandler`), `@app/infrastructure/rate-limit` (S50), `ShopQueryService` (S03 R1), `UserDirectoryService` (S01 R1), `DiscussionQueryService` (S25), `CLOCK`, `MetricsRegistry`, `fast-check`
**Storage**: ScyllaDB (durable, `community`-owned tables, new `062_feed_s26.cql`); Redis `fd:*` (derived, every key with a TTL); no PostgreSQL table, no SQL transaction
**Testing**: jest e2e via `/opt/sdd/repo/scripts/sdd/test-spec.sh` (the six `follow-graph|feed-*.e2e-spec.ts` files of `test-plan.md`), unit specs beside `domain/` (`merge`, `cursor`, `item-rules`, `version-guard`); journey J05 (not owned here)
**Target Platform**: Linux; `apps/core` (HTTP), `apps/projector` (consumers), `apps/worker` (jobs)
**Project Type**: backend domain module + contracts package
**Performance Goals**: SC-001 fan-out p99 < 5 s for 10,000 followers; SC-004 page p95 < 300 ms, rebuild of 500 followed accounts < 2 s (ops artifacts, not proven by e2e); per-page store reads bounded (5 × limit candidates)
**Constraints**: timeline Redis call 150 ms, celebrity recents read 400 ms, history read 800 ms, hydration source 600 ms, directory lookup 300 ms; rebuild concurrency 16; fan-out page 1,000 followers (test 2); window 800 (test 5); celebrity threshold 10,000 (test 3); following limit 2,000 (test 3); R3 copy staleness ≤ 10 s
**Scale/Scope**: 20M-follower authors, 2,000 followed accounts per buyer, 800-entry timelines, 200-entry celebrity recents, 90-day retention

**Connection arithmetic (III.12)**: no PostgreSQL connection is opened by `community` feed code; Scylla uses the shared driver pool, Redis the shared client; rebuild concurrency 16 per request is bounded per process by a shared semaphore (default 64) so many simultaneous returning users cannot exhaust the pool.

## Constitution Check

| Gate | Status | How |
|---|---|---|
| 1 Layers (I.1–I.3) | PASS after work (D-6) | ports + tokens in `domain/ports.ts` (follow graph, item store, timeline, celebrity, product copy, claim, announcement, directories, clock); `application/` imports no `infra/` (E2); `domain/` has no `Date.now()`/`new Date()`/`node:crypto` |
| 2 Pipeline (II) | PASS after work | thin controller; DTOs validate id shape, limit, cursor, `accountIds`; domain errors with `code` rendered by the global filter (A1); `Firewall()` on all routes |
| 3 Data access (III) | PASS after work | only `infra/` touches Scylla/Redis; invariants by LWT / `IF NOT EXISTS` (relation, claim, limit, celebrity), not check-then-write; keyset cursors with a unique tiebreaker (III.10); every Redis key has a TTL (III.9), no `KEYS`/`SCAN`; additive CQL only; `.tx.baseline` = 0 and no `sequelize.transaction` is added |
| 4 Messaging (IV) | PASS after work | events recorded in the item batch and relayed at least once; consumers idempotent, validated, dead-lettering; per-call timeouts; other domains reached only through R1 exports in ACL adapters (IV.8) |
| 5 Contracts (V) | PASS after work | zod schemas `FeedPage`, `FeedItemView`, `FollowingPage`, `FollowStatus` + error codes + `feed.item_published` in `packages/contracts`; problem+json; `GET` changes no state (the `act` marker slide is cache metadata, not domain state); no `Idempotency-Key` (V.6 does not list follows; set semantics) |
| 6 Frontend (VI) | N/A here | no web owner (gaps.md) |
| 7 Tests (VII) | PASS after work | 51 scenarios mapped in `test-plan.md`; every fallback forced (AS-28/30/33/37/41/42/45/46/48); concurrency by `Promise.all` ×20; responses parsed with contract schemas |
| 8 Operations (VIII) | PASS after work | structured `feed.fanout.completed`, `feed.degraded`, `feed.fanout.failed` lines (no follower ids); metrics of AS-50; jobs scheduled once per tick; config keys joi-validated |
| 9 DB isolation (IX) | PASS after work | `ProductModel` / `Product` reads removed (D-7, D-12); `check:table-ownership --strict` shows zero community lines; R3 copy owned by `community`, R1 for shops/users/posts |
| 10 Monorepo (X) | PASS after work | barrel exports modules + `FollowQueryService`, no consumer/projector/publisher class (D-8); `FeedModule` no longer `@Global` (E4) |

Post-design re-check: still PASS. Risks: (a) `USING TIMESTAMP rel_ts` mixes explicit and default write timestamps on the same cells; every writer of those cells goes through `ScyllaFollowStore`, legacy rows migrate lazily (R-1), and a lint-level check (grep in the final gates task) ensures no other file writes `followers_by_account`/`following_by_time`; (b) the reconciliation scan is long at 10⁸ relations (paged, resumable, paced); (c) the pull continuation past the window costs up to ~2,000 author reads per page in the worst case: bounded by the 5 × limit scan cap, the concurrency 16 and the per-call timeout, and marked `degraded: true` when cut; (d) the 10 s R3 staleness bound; (e) the topic registry must know the `feed` aggregate (first relay task registers `FEED_AGGREGATE`).

## Follow-ups from built sibling specs (treated as requirements)

1. **S05 → S26**: consume the full-state `catalog.product_*` events (`productVersion`, `priceMinor`, `status`, `isSandbox`, `shopId`) instead of reading `Product`; the `products` topic is compacted (`latest-per-key`), replay yields the latest snapshot per product, `catalog.product_deleted` = tombstone state "remove"; `catalog.product_changed` is ignored (research R-6; tasks T20–T24).
2. **S28 → S26**: export `FollowQueryService.getFollowerIds(accountId, {limit ≤ 1000, cursor?})` from `@app/domains/community` and publish `feed.item_published` v1 `{itemId, authorId, kind, createdAt}` (contracts/follow-feed-api.md, contracts/events.md; T07, T27, T31).
3. **S29 → S26**: item payloads carry no image (AS-43 exact), so no `media.gallery_changed` consumer; the feed never polls `ProductMedia`; clients resolve images via `/batch/media` from `payload.productId` (research R-12; `gaps.md` follow-ups).
4. **S49 → S26**: `declareJobType` with payload contracts next to the `JobPayloads` augmentation for `feed.relay-announcements`, `feed.relay-sweep`, `feed.reconcile`; `InvalidScheduleError` caught at registration; no `JobsService.cancel` caller exists in this domain (T33).
5. **S50 → S26**: `follow.write` and `feed.read` move into `rate-limit-policies.ts` (`definePolicies` + `forFeature`, registered by `FeedModule`); controllers use `@RateLimit`; contract documents `RateLimit` / `RateLimit-Policy` headers, `503 rate_limiter_unavailable`, `422 rate_limit_cost_exceeded`; e2e adopts them (T14, AS-09).
6. **S54 toolkit**: community opens no transaction; nothing to migrate, nothing added.
7. **gaps.md items**: every row A1–A9, B1–B8, C1–C6, D1–D7, E1–E5 and the debt rows D-6, D-7, D-8, D-12 are in the tasks below (mapping in "Technical tasks by gap").
8. **Living specification**: `docs/spec/capabilities/` has no page for S26, so rule (0) has nothing to edit first; the last task adds `docs/spec/capabilities/S26-follow-feed.md` with `[proof: …]` / `[code: …]` anchors, validated by `python3 scripts/livespec/check.py`. No `*.reviewed.json` is created or edited; nothing signed changes (`gaps.md` "Spec changes").

## Project Structure

### Documentation

```text
specs/domains/S26-follow-feed/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/follow-feed-api.md  contracts/events.md
└── tasks.md   # /speckit-tasks
```

### Source code (`packages/backend/libs/domains/community/`; contracts in `packages/contracts/src/community/`; CQL in `packages/backend/cql/`)

```text
packages/backend/cql/062_feed_s26.cql                 # additive columns + tables of data-model.md
packages/contracts/src/community/feed.ts              # FeedPage, FeedItemView, FollowingPage, FollowStatus, error codes
packages/contracts/src/community/events.ts            # extend: feed.item_published schema
packages/backend/libs/common/config/…                 # feed config keys (thresholds, windows, timeouts, concurrency), joi-validated
community/
├── api/
│   ├── feed.controller.ts                            # rewritten: follow, unfollow, following, follow-status, feed; thin
│   └── feed.dto.ts                                   # params/query DTOs (account id, limit, cursor, accountIds)
├── application/
│   ├── follow.service.ts                             # follow/unfollow/limit/validation/status/list (A1–A6, A9)
│   ├── follow-query.service.ts                       # R1 export getFollowerIds (S28)
│   ├── feed-read.service.ts                          # candidates, merge, fill loop, degraded (D1–D6)
│   ├── timeline-rebuild.service.ts                   # pull, single flight, union, completion marker (D4)
│   ├── feed-hydration.service.ts                     # batched sources, visibility rules (D5)
│   ├── item-projection.service.ts                    # event → claim → batch (B1–B4)
│   ├── fanout.service.ts                             # pages, pipelined pushes, celebrity, marker (C1–C4)
│   ├── announcement-relay.service.ts                 # pending → publish → delete (B2)
│   └── feed-reconcile.service.ts                     # counts, half-written relations (A7)
├── domain/
│   ├── ports.ts (+tokens)                            # all stores/caches/directories (D-6, E2)
│   ├── merge.ts (+spec)                              # k-way by (ms, sortableId), de-dup, cursor, limit (D2)
│   ├── feed-cursor.ts (+spec)                        # opaque keyset cursors for feed and following (D1)
│   ├── item-rules.ts (+spec)                         # event → item mapping, price-drop rule (B3)
│   ├── version-guard.ts (+spec)                      # product copy version and deletion-first rules (B4)
│   ├── feed-errors.ts                                # DomainError codes (account_not_found, …)
│   └── feed-keys.ts                                  # Redis key builders (moved from application/, E2)
├── infra/
│   ├── scylla-follow.store.ts  scylla-feed-item.store.ts  scylla-product-copy.store.ts  scylla-celebrity.store.ts
│   ├── scylla-announcement.store.ts
│   ├── redis-timeline.store.ts                       # timeline, active marker, recents, caches; Lua scripts
│   ├── shop-directory.adapter.ts                     # S03 ACL;  account directory: reuse/extend S25's identity adapter
│   ├── feed-projectors.ts                            # four Projector classes
│   ├── feed.jobs.ts                                  # relay, sweep, reconcile (declareJobType)
│   └── feed-metrics.ts
├── feed.module.ts  feed-worker.module.ts  feed-projectors.module.ts  index.ts   # barrel: modules + FollowQueryService
├── follow-graph.e2e-spec.ts  feed-items.e2e-spec.ts  feed-read.e2e-spec.ts
├── feed-celebrity.e2e-spec.ts  feed-rebuild.e2e-spec.ts  feed-fanout.e2e-spec.ts   # replace feed.e2e-spec.ts
└── testing/feed-fixtures.ts                          # shared fixtures, fault-injecting store wrappers, frozen clock
apps/projector/src/projector.module.ts                # swap FeedFanoutConsumer/ProductFeedProjector/FeedPublisherModule → FeedProjectorsModule
apps/worker                                           # import FeedWorkerModule
apps/core/src/core.module.ts                          # FeedModule stays (no longer global)
docs/spec/capabilities/S26-follow-feed.md             # living page (last task)
scripts/load-tests/feed.test.js                       # ops artifact (SC-001, SC-004)
```

Deleted: `application/feed.service.ts`, `application/feed-publisher.service.ts`, `feed-publisher.module.ts`, `infra/fanout.consumer.ts`, `infra/product-feed.projector.ts` (replaced), `feed.e2e-spec.ts` (replaced, scenarios preserved per L-017: each old scenario — follow/unfollow, product item, fan-out push, celebrity merge, rebuild — is covered by a named AS in the new files).

**Structure Decision**: stay inside `community` (no new deployable, I.6); three Nest modules by process (HTTP, projectors, jobs) so each deployable boots on its own (L-018) and shares one set of store providers through a `FeedStoresModule`, as S25 does with `DiscussionsStoresModule`.

## Technical tasks by gap (input for `/speckit-tasks`)

Order is test-first within each step; the whole capability suite runs once at the end (L-008: batches of fresh processes). No task runs, records or proves a runtime check (boot, fresh stack, journey): those belong to the final checkpoint (L-019).

1. **Contracts, config, schema, ports (T01–T08)**: `062_feed_s26.cql`; `feed.ts` schemas + error codes + `feed.item_published` (B6, D7); config keys + joi; `FEED_AGGREGATE` registration (E5); ports and tokens, key builders moved to `domain/` (E2, D-6); metrics registry; `FeedStoresModule`.
2. **Pure logic with unit specs (T09–T13)**: `merge.ts` rewrite with `(ms, sortableId)` order and cursor (D2, AS-18/26/31, fast-check); `feed-cursor.ts` (D1, tamper); `item-rules.ts` (B3, B5 integer money, price-drop table); `version-guard.ts` (B4, deletion-first).
3. **Follow graph (T14–T22)**: `ScyllaFollowStore` (LWT with `rel_ts`, timestamped derived writes, limit reservation, list/status reads) (A2, A3, A4); `FollowService` + validation through S03/S01 adapters (A1); DTOs + controller + rate-limit policies (A1, A5, A6, A8); `FollowQueryService` (S28); follow/unfollow clear `tlc`/`cf` (A9); `follow-graph.e2e-spec.ts` (AS-01–AS-12, AS-51 with the reconciliation service from T37).
4. **Items from events (T23–T30)**: `ScyllaFeedItemStore` (claims, logged batch with announcement, TTLs) (B7, B8); product copy store and projector (B3, D-7, D-12); post and auction projectors; announcement relay and jobs (B2, E5); `feed-items.e2e-spec.ts` (AS-13–AS-17).
5. **Fan-out (T31–T35)**: `RedisTimelineStore` (Lua push/trim/expire, active batch check), `ScyllaCelebrityStore` + promotion on follow (C1, C2), `FanoutService` with completed marker, pipelined pages, backpressure, structured line and metrics (C3–C6); `feed-fanout.e2e-spec.ts` (AS-22, AS-44–AS-50) and `feed-celebrity.e2e-spec.ts` (AS-24–AS-30).
6. **Read path (T36–T42)**: `FeedReadService` (candidates, merge, pull continuation, fill loop) (D1, D2, D3); `TimelineRebuildService` (single flight, union, completion marker, bounded concurrency) (D4); `FeedHydrationService` (batched, fail closed, degraded) (D5, D6); Redis-down pull fallback (D6); `feed-read.e2e-spec.ts` (AS-18–AS-21, AS-23, AS-38–AS-43) and `feed-rebuild.e2e-spec.ts` (AS-32–AS-37).
7. **Reconciliation (T43–T44)**: `FeedReconcileService` + `feed.reconcile` job (A7); covered by `follow-graph.e2e-spec.ts` AS-51.
8. **Modules, barrel, cleanup (T45–T49)**: `FeedModule` (not global), `FeedWorkerModule`, `FeedProjectorsModule`; barrel (E3, E4, D-8); `apps/projector`, `apps/worker`, `apps/core` imports; delete the replaced files; remove the old unprefixed Redis keys (one-off `UNLINK` by explicit name in the first reconcile run).
9. **Gates and docs (T50–T54)**: `tsc --noEmit`, ESLint, `pnpm check:boundaries`, `check:table-ownership --strict` (zero community lines), `check:module-graph`, `check:model-registry`; the grep gate for direct writers of timestamped tables; `scripts/load-tests/feed.test.js` (ops artifact, written not run); living page `docs/spec/capabilities/S26-follow-feed.md` + `python3 scripts/livespec/check.py`; whole capability suite once.

## Complexity Tracking

| Violation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Scylla relay table instead of the infrastructure outbox | `community` owns no PostgreSQL table (D5) | A SQL outbox row beside a Scylla write is a dual write (IV.4) |
| `rel_ts`-timestamped writes to derived tables | Two partitions cannot be changed by one LWT; timestamps from the winner's sequence make the sides converge (AS-06) | Check-then-write with Redis (A2) or a second LWT that can itself half-apply |
| `follow_*` tombstone rows kept (`active = false`) | The sequence must survive an unfollow so a late follower-side write loses | Deleting the buyer row loses the ordering and reopens the race |
| Pull continuation past the pushed window | A feed must not dead-end at 800 (D3) | Larger windows only move the cliff and cost memory |
| Three Nest modules (HTTP, projectors, jobs) | Each deployable must boot alone (L-018); D-8 forbids exporting consumers | One module imported by all three apps pulls HTTP into the projector |
