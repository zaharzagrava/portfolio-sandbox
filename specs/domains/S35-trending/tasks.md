# Tasks: S35 — Trending Products

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md`, `data-model.md`, `research.md`, `contracts/trending-api.md`, `quickstart.md` in `specs/domains/S35-trending/`.
**Tests**: requested (constitution VII, `test-plan.md`). For every test-plan row the failing test task comes before the code task.

## Conventions

- `D/` = `packages/backend/libs/domains/discovery/` (e2e files and unit specs live there; unit specs in `D/domain/`). `C/` = `packages/contracts/src/`. Run backend commands from `packages/backend`.
- Run e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>`; narrowest test first, whole capability suite once in the last phase. After 5 failed fixes of the same test: stop and write blocker, attempts and hypothesis into `questions.md`.
- Never use git checkout/restore/reset/stash/clean; undo by editing by hand and keep other changes.
- Transactions: the trending files hold none (`.tx.baseline` = 0). Do not add `sequelize.transaction`; delete the injected `Sequelize` (T05).
- Follow-ups treated as requirements: **S05** (no `JOIN "Product"`/`ProductModel`/raw SQL; `getProductsByIds(ids)` one batch per request, no `shopId`; `ProductService.search` unused) → T0xx tasks marked (S05). **S50** (`discovery.trending` policy declared, `@RateLimit` replaces `skipThrottle`; G-35 lists no mis-used policy at a trending call site, so nothing to rename) → marked (S50).
- Gap IDs (T01–T57, D-6, D-7, D-8, D-12) are cited in each task; the coverage table at the end proves every item has a task.

---

## Phase 1: Setup

- [X] T001 Read the current trending files once to anchor line ranges: `D/api/trending.controller.ts`, `D/application/trending.service.ts`, `D/infra/trending.consumer.ts`, `D/domain/count-min-sketch.ts`(+`.spec.ts`), `D/trending.module.ts`, `D/index.ts:13-19`; record baselines with `pnpm --dir packages/backend check:table-ownership` (1 of 7 discovery lines is trending) and `check:boundaries`. No file changes.
- [X] T002 [P] Add `fast-check` to `packages/backend` devDependencies only if absent (`pnpm --dir packages/backend ls fast-check`); add a seeded PRNG helper `D/domain/testing/seeded-random.ts` (mulberry32, `(seed:number)=>()=>number`) used by every unit spec instead of `Math.random` (T43).

---

## Phase 2: Foundational (blocks all stories)

**Contracts**

- [X] T003 [P] Write failing contract spec `C/search/trending.spec.ts`: `trendingQuerySchema` is `.strict()`; `category` 1–40 chars `^[a-z0-9-]+$` default `all`; `limit` integer 1–20 default 20 via regex-guarded coercion (`2.5`, `''`, `abc`, `0`, `21` fail); unknown key fails (FR-002, AS-03, AS-04, T02).
- [X] T004 Create `C/search/trending.ts` with `trendingQuerySchema`, `trendingResponseSchema` (`{category, windowMinutes: 60 literal, generatedAt ISO string, items:[{rank int ≥1, productId uuid, title, priceMinor int, currency, category, score int}]}`) and the item type; export from `C/search/index.ts` (T03, FR-003). Depends on T003.
- [X] T005 [P] Check whether `storedAnalyticsEventSchema` exists in `C/` (S39). If absent add `C/analytics/stored-event.ts` with the shape in `spec.md` "Requires": `{event_id, name, anonymous_id, user_id, ts, received_at, props}` with `ts`/`received_at` as `YYYY-MM-DD HH:mm:ss.SSS` UTC strings; export it (plan risk a). Add spec `C/analytics/stored-event.spec.ts` first (valid, bad timestamp, missing `event_id`).

**Config**

- [X] T006 [P] Write failing unit spec `D/domain/trending-config.spec.ts` (U6, AS-37): `it.each` over each invalid setting naming the key — weights integers ≥ 1, window fixed 60, lateness 0–600 s, idle ≥ 1, heap K ≥ 40, widths powers of two, depth 1–8, category cap ≥ 1, memory budget ≥ 1 MB, retention ≥ 60 min + lateness + correction horizon and ≤ 3 h, budgets positive; defaults 1/5, 60 s, 120 s, 30 s, 50, 2^16/2^14, 4, 100, 512, 10800 s, 100/100/50/100 ms.
- [X] T007 Implement pure validation `D/domain/trending-config.ts` (U6 green; R-13). Then joi keys `TRENDING_*` in `packages/backend/libs/common/config/trending-config.ts`, register in `api-config.service.ts`, and `D/infra/trending-config.ts` exposing `TrendingSettings` (T31, FR-026, AS-37).

**Ports, keys, policy, metrics**

- [X] T008 [P] Create `D/domain/trending-ports.ts` (D-6, T12): interfaces and injection tokens `TrendingAggregateReader` (windows+budget → `{productId, score}[]`), `TrendingAggregateWriter` (idempotent merge by partition, window, offsets, ttl → `applied|replayed`; throws on failure), `TrendingCatalogFacts` (`lookup(ids) → Map<id, {title, priceMinor, currency, category, status, isSandbox, inStock, shopStatus}>`), `CorrectionDedupe` (`claim(eventId) → boolean`). Create `D/domain/trending-errors.ts` with `TrendingUnavailableError` (503 `trending_unavailable`, `Retry-After: 5`).
- [X] T009 [P] Create `D/infra/trending-keys.ts`, sole owner of the key space (AS-39, T34): `aggregateKey(category, windowStartMs)`, `mergeKey(partition, windowStartMs)`, `correctionMergeKey(partition, windowStartMs, first, last)`, `seenKey(eventId)`, `rankCacheKey(category, boundaryMs)`; no `KEYS`/`SCAN`, every key gets a TTL.
- [X] T010 [P] (S50) Add `discovery.trending` (300 per minute, key `ip`, fail open) to `D/rate-limit-policies.ts` `discoveryRatePolicies` (T09, FR-009). Policy name must match exactly. Confirm by grep that no trending call site uses another domain's policy name (G-35: nothing to rename).
- [X] T011 [P] Create `D/infra/trending-metrics.ts` registering via `MetricsRegistry` the series from R-17 with fixed-enum labels only: `trending_events_total{outcome}` (counted, invalid, ignored, duplicate, capped_visitor, late_corrected, late_dropped, category_capped), `trending_windows_closed_total`, `trending_merges_total{outcome}` (applied, replayed, failed), `trending_last_merge_timestamp_seconds`, `trending_oldest_unmerged_window_age_seconds`, `trending_consumer_lag`, `trending_tracked_bytes`, `trending_requests_total{outcome}`, `trending_dependency_failures_total{dependency}`, `trending_ranking_cache_total{result}`, `trending_consumer_connect_failures_total` (T35, FR-025).
- [X] T012 Create fixtures `D/trending.fixtures.ts`: boot helper (`TrendingModule` + `TrendingProjectorModule` + real `ProductModule`/`TenancyModule`, production pipe/filter/prefix/interceptors, `clean()`, flush trending keyspace, fresh consumer group id), a builder for dataset T (spec.md line ~37) that produces events through the real topic and the real consumer, a counting wrapper around the Redis client and the R1 services, a fault/delay injector for Redis and R1, and a frozen/advanceable `CLOCK`. Depends on T008–T011.

**Checkpoint**: contracts, config, ports, keys, policy, metrics, fixtures exist; `tsc --noEmit` passes.

---

## Phase 3: User Story 4 — Approximate top-K, accurate and bounded (P1)

**Goal**: pure sketch/heap/merge correctness. **Independent test**: unit specs U1, U2, U8 green on seeded streams.

- [X] T013 [P] [US4] Rewrite `D/domain/count-min-sketch.spec.ts` (U1, AS-23, AS-28, T43): seeded Zipf stream (no `Math.random`), `it.each` over widths/depths; properties (fast-check): estimate ≥ exact; error ≤ ε·N with probability bound; `merge(a,b)` equals sketch of whole stream; fixed byte size; counters saturate at 2^32−1 and never wrap.
- [X] T014 [P] [US4] Create `D/domain/top-k.spec.ts` (U2, AS-24, T41): the worked table of heap eviction order, in-place update of an existing member, ties broken by `productId` ascending by code unit (not `localeCompare`, test with non-ASCII ids); property: heap equals the K largest of an exact count.
- [X] T015 [US4] Fix `D/domain/count-min-sketch.ts` to green U1: saturating add (`Math.min(0xFFFFFFFF, …)`), `merge(other)` for equal dimensions (throws otherwise), keep `murmur3` from `libs/common/core/murmur3.ts` (T40, T42).
- [X] T016 [US4] Create `D/domain/top-k.ts` (min-heap, in-place update, code-unit tie order) by splitting it out of `count-min-sketch.ts`; remove the heap and `TumblingWindows` from the old file; U2 green (T41).
- [X] T017 [P] [US4] Create `D/domain/trending-accuracy.spec.ts` (U8, AS-25, SC-002): seeded stream ≥ 200,000 events over 20,000 products, precision of approximate top-10 ≥ 0.9 against exact, no estimate below true count, threshold stays "≥ 9 of 10". Run; fix parameters only through config defaults, not by loosening the test.

**Checkpoint**: `test-spec.sh libs/domains/discovery/domain/count-min-sketch libs/domains/discovery/domain/top-k libs/domains/discovery/domain/trending-accuracy` green.

---

## Phase 4: User Story 3 — Counting by event time in one-minute windows (P1)

**Goal**: pure event normalisation, watermark, idle advance, classification, visitor cap. **Independent test**: U3, U5, U7 green.

- [X] T018 [P] [US3] Create `D/domain/trending-event.spec.ts` (U5, AS-16, AS-20, T21): `it.each` over event names/props — `product_view` weight 1, `add_to_cart` weight 5, other names ignored (counted `ignored`), missing/non-UUID `product_id` ignored, category valid only if `^[a-z0-9-]{1,40}$` else `all` only; strict timestamp parser for `YYYY-MM-DD HH:mm:ss.SSS` UTC (invalid → `invalid`, no NaN); event time = `min(ts, received_at)`.
- [X] T019 [US3] Implement `D/domain/trending-event.ts` (U5 green): `normalise(storedEvent, settings) → {kind:'count', eventId, visitorKey, name, productId, category|null, weight, eventTimeMs, receivedAtMs} | {kind:'ignored'}`; throws a typed parse error for bad timestamps (consumer dead-letters). No wall clock (FR-028).
- [X] T020 [P] [US3] Create `D/domain/tumbling-windows.spec.ts` (U3, AS-17, AS-19, AS-20, AS-21, T22–T24, T44): table of event times and watermarks (out-of-order events land in their event-time window; window closes when watermark ≥ end); `watermark = min(maxEventTime, maxReceivedAt) − lateness` so a forged future `ts` cannot move it; idle advance only for a partition silent ≥ `idleMs` to `now − lateness`, never for a busy partition; classification `open | late_corrected (closed, start ≥ horizonStart(now)) | late_dropped`; closed windows never reopen; all with injected `now`.
- [X] T021 [P] [US3] Add commit-floor cases to `D/domain/tumbling-windows.spec.ts` (U3, R-2): floor = min first offset of any open/closed-pending/merge-failed window or correction buffer; none → `lastConsumed + 1`; per partition.
- [X] T022 [US3] Implement `D/domain/tumbling-windows.ts` (per-partition state, `observe`, `tick(now)`, `classify`, `closeReady`, `markMerged`, `markMergeFailed`) and `D/domain/commit-floor.ts` (T22–T24, T44, T27). U3 green.
- [X] T023 [P] [US3] Create `D/domain/visitor-cap.spec.ts` (U7, AS-22, AS-29, SC-005, T28): per visitor, name, product, window at most one vote; separate windows/names/products count separately; Bloom-style membership: property no false "unseen"; seeded stream false-"seen" ≤ 1%; `eventSeen` filter for duplicate `event_id`; filters discarded at merge.
- [X] T024 [US3] Implement `D/domain/visitor-cap.ts` (two bit-array Bloom filters from `murmur3`, size from config, `k` hashes) (T28, R-7). U7 green.
- [X] T025 [P] [US3] Create `D/domain/trending-ranking.spec.ts` (U4, AS-05, AS-18, T07, T08, T13): serving window set at frozen instants 11:59:20, 12:01:05, 12:02:05 (60 windows ending at the last boundary, current minute excluded); order score desc then `productId` asc by code unit, byte-identical replay, ranks without gaps; property: order independent of input order; pool size `min(3 × limit, 60)`; pure `selectVisible(pool, facts, category, limit)` (ACTIVE, not sandbox, in stock, shop ACTIVE, `category==='all' || facts.category===category`, unknown ids dropped, no padding, ranks after filtering) — also covers AS-10/11/12 logic.
- [X] T026 [US3] Implement `D/domain/trending-ranking.ts` (`servingWindows(now)`, `sumAndOrder`, `poolSize`, `selectVisible`) (T07, T08, T13). U4 green.

**Checkpoint**: `test-spec.sh libs/domains/discovery/domain` fully green (U1–U8).

---

## Phase 5: User Story 5 — Every event counts once, none lost (P1) and User Story 6 stream parts (P2)

**Goal**: the stream path with idempotent merge and commit floor. **Independent test**: `trending-stream.e2e-spec.ts` (S).

### Tests first (all in `D/trending-stream.e2e-spec.ts`, top-level `describe('Trending streaming aggregation')`; each asserts response/persisted effect: aggregates + TTL, merge records, committed offsets, DLQ rows, metrics; fresh group id per test)

- [X] T027 [US5] Create `D/trending-stream.e2e-spec.ts` skeleton with fixtures (T012) and the AS-29/AS-30 pair (VII.4, T20, T21, T28): (AS-29) the same envelopes twice in one batch, in different batches and after a restart → one effect; (AS-30) invalid payloads (non-JSON, schema violation, bad timestamp) → dead-letter `discovery-trending-topk.dlq` with code `INVALID_PAYLOAD` + reason (schema paths only), no counter side effect except `invalid`, partition not blocked. Expect red.
- [X] T028 [US5] Add AS-26 case (multi-level merge): two partitions, sums across partitions, a product present in only one partition's top-K still ranked; AS-27 case: 1,000 categories and 10,000 products → only valid slugs tracked up to 100 per partition-window, rest counted `category_capped` and in `all`, `trending_tracked_bytes` gauge within budget (T29, T30).
- [X] T029 [US5] Add AS-19 case (late events): within lateness counted normally; beyond lateness inside the 60-min horizon → correction merge applied once (own merge record, `trending:seen:{id}` dedupe) and visible; older → `late_dropped` counter; AS-21 case: quiet partition becomes visible with no later event after the clock advances, a busy partition is not advanced (T23, T24).
- [X] T030 [US5] Add AS-31 (crash after merge before commit → replay changes nothing, `merge_replayed`), AS-32 (crash without shutdown hooks loses nothing; scores equal an uninterrupted run; committed offsets never pass the earliest unmerged window), AS-33 (partition moves; two consumer modules; two real merges with `Promise.all` apply once) (T25, T26, T27).
- [X] T031 [US5] Add AS-34 (graceful shutdown merges every open window and commits the floor) and AS-35 (Redis fault injection during merge: ≤ 3 attempts with full-jitter backoff at one layer, no commit past the window, buffering then pause/backpressure at memory budget, all-or-nothing aggregate, resumes when Redis returns) (T33, T26, T30).

### Implementation

- [X] T032 [US5] Implement `D/infra/redis-trending-aggregate.adapter.ts` writer: one atomic Lua `EVAL` (R-3): `KEYS=[mergeKey, aggregate keys…]`, `ARGV=[ttl, first-last, (member, score)…]`; `SET mergeKey NX EX ttl` → exists returns 0 (replayed); else `ZINCRBY` each pair, `EXPIRE` each aggregate to `retentionSeconds` (default 3 h max), return 1; command timeout 100 ms; check the result, throw on failure; no client-level retry (T26, T34, FR-019, FR-022).
- [X] T033 [P] [US5] Implement `D/infra/redis-correction-dedupe.adapter.ts` (`SET trending:seen:{eventId} NX EX retention` via `trending-keys.ts`).
- [X] T034 [US5] Create `D/application/trending-ingest.service.ts`: per message `storedAnalyticsEventSchema` parse → `normalise` → event-id and visitor caps → per-**partition** window state with CMS+heap per tracked category and `all` (all 2^16×4, category 2^14×4, K=50, cap 100, `trackedBytes` and 80% / 100% memory rules) → classification (open / correction / dropped) → close ready windows → merge via writer with 3 attempts and full-jitter backoff (the only retry layer) → commit floor; metrics from T011; injected `CLOCK`; no identifiers in logs or labels (T20–T35, T27, T28, T29, T30, FR-011–FR-022, FR-025). Invalid input → `DeadLetterWriter` with reason, no side effect (T20).
- [X] T035 [US5] Rewrite `D/infra/trending.consumer.ts` (R-1, R-14, R-15, T20, T25, T32, T33): kafkajs `eachBatch`, `autoCommit:false`, group `discovery-trending-topk`, topic `analytics.events`, delegate to ingest service, commit the floor with `consumer.commitOffsets`, 5 s tick timer driving `tick(now)`, pause/resume under backpressure, connect and subscribe in a retry loop with timeout, backoff + jitter, counter `trending_consumer_connect_failures_total`, no swallowed errors; `ReadinessService.register({name:'trending-consumer'})` ready only after subscribe + run started; `run()` rejection or `CRASH` → not ready and exit through an injectable `ProcessExit`; `ShutdownRegistry` task phase `drain` that pauses, force-closes and merges owned windows, commits the floor, disconnects. Reuses `createKafka`, `DeadLetterWriter`, `MetricsRegistry`, `CLOCK`.
- [X] T036 [US5] Wire `D/trending.module.ts`: split into `TrendingModule` (core: controller, read service, reader, catalog facts adapter, cache) and `TrendingProjectorModule` (projector: consumer, ingest service, writer, dedupe, metrics), explicit imports, providers bound to the port tokens, exports only what apps need (T50, FR-024).
- [X] T037 [US5] Run `test-spec.sh trending-stream`; iterate to green (max 5 attempts per failing test, then record in `questions.md`).
- [X] T038 [US5] (T52, T57) Move the trending case out of `libs/domains/marketing/ads.e2e-spec.ts`: remove only lines 19-21 imports of `TrendingConsumer`/`TrendingService` and the trending case at 114-129 (edit by hand, keep every other change); rename or leave the sponsored-clicks `describe` at line 27 so it no longer claims trending; run `test-spec.sh libs/domains/marketing/ads` green. Record in `gaps.md` Sibling-spec follow-ups that S36 lost the case (already listed).

**Checkpoint**: stream e2e green; the ranking can be filled through the real topic.

---

## Phase 6: User Story 1 — See what is trending in the last hour (P1) 🎯 MVP read path

**Goal**: `GET /api/trending` envelope. **Independent test**: `trending-read.e2e-spec.ts` (R) cases AS-01…AS-09, AS-15, AS-18.

### Tests first (`D/trending-read.e2e-spec.ts`, `describe('Trending products API')`; parse 200 bodies with `trendingResponseSchema` and errors with the problem schema; frozen clock; dataset T via real consumer)

- [X] T039 [US1] Create `D/trending-read.e2e-spec.ts` with AS-01 (happy path, `Cache-Control: public, max-age=30, s-maxage=30`, schema parse, no state change on GET), AS-02 (default category `all`, items carry the catalog category), AS-06 (no traffic or unknown well-formed category → `200` empty `items`, never `404`). Red (T01, T04, FR-003, FR-005).
- [X] T040 [US1] Add AS-03 (limit default 20, bounds 1–20, invalid values) and AS-04 (validation `400` problem+json `validation_failed`, category alphabet and length 41 chars, `{`,`}`,`*`,`:`, unknown parameter, and the Redis client and R1 call counters stay 0) (T02, FR-002).
- [X] T041 [US1] Add AS-07 (identical body for every caller, invalid token ignored, no cookie, no `Vary`, no identifiers in log output or metric labels) and AS-08 (policy `discovery.trending`: 300/min per address → `429` `rate_limited` with `Retry-After`; fail open when the limiter store is down) and AS-09 (`400` and `429` carry `Cache-Control: no-store`) (T09, T14, FR-008, FR-009).
- [X] T042 [US1] Add AS-15 (concurrent cold reads via `Promise.all` share one aggregate read, asserted by the counting Redis wrapper; `limit=2` and `limit=20` share one ranking) (T11, FR-007).

### Implementation

- [X] T043 [US1] Implement reader in `D/infra/redis-trending-aggregate.adapter.ts`: `ZUNION` over the computed 60 keys with `WITHSCORES` under a 100 ms budget, top 60 pairs; any failure or timeout → `TrendingUnavailableError` (T10, T12, FR-004, FR-010, R-9).
- [X] T044 [US1] Rewrite `D/application/trending.service.ts` (T01, T05, T06, T07, T08, T10, T11, T12, T13; D-6; S05): depends on port tokens only (no `infra/` import, no injected `Sequelize`/Redis, no `Date.now()` — use `CLOCK`); ranking through `CacheService.getOrLoad` (single flight, key `rankCacheKey`, TTL 30 s, L1 off) holding only `{productId, score}`, `?? []` deleted, any throw → `TrendingUnavailableError`; pool `min(3 × limit, 60)`; one `lookup` per request; `selectVisible`; response `{category, windowMinutes: 60, generatedAt, items}`; metrics `trending_requests_total`, `trending_ranking_cache_total`.
- [X] T045 [US1] Rewrite `D/api/trending.controller.ts` (T02, T09, T14; S50; II.1): strict `trendingQuerySchema` parse (`.strict()`), `@RateLimit('discovery.trending')` replacing `@Firewall({skipThrottle:true})` while keeping `@Firewall({anonymous:true})`, sets `Cache-Control: no-store` first and replaces with `public, max-age=30, s-maxage=30` only after a body, one call to `TrendingService`, no logic.
- [X] T046 [US1] Run `test-spec.sh trending-read` for the T039–T042 cases to green; iterate (max 5 per failure).

**Checkpoint**: MVP — real events through the stream appear at `GET /api/trending`.

---

## Phase 7: User Story 2 — Only products I can buy, in the category asked (P1)

**Goal**: R1-backed visibility, always at origin. **Independent test**: read e2e AS-10…AS-14.

### Tests first (append to `D/trending-read.e2e-spec.ts`)

- [X] T047 [US2] Add AS-10 (archived, sandbox, out-of-stock, non-active-shop candidates dropped and replaced from the pool; pool size `min(3 × limit, 60)`; exactly one `getProductsByIds` and one `getShopsByIds` call per request, via the counting wrapper over the real services) and AS-11 (catalog category is authoritative: a product trending under an event-claimed category it does not belong to is absent from that category's list) and AS-12 (fewer than asked, or all hidden → `200` with fewer/empty items) (T04, T08, FR-006).
- [X] T048 [US2] Add AS-13 (stock and price change seen at origin immediately, even while the ranking is cached; `priceMinor` integer and `currency` from R1) (T06, FR-007).
- [X] T049 [US2] Add AS-14 (fault injection: aggregate store down, aggregate slow > 100 ms, product lookup down/slow > 100 ms, shop lookup down/slow > 50 ms, cache failure → `503` problem+json `trending_unavailable`, `Retry-After: 5`, `Cache-Control: no-store`, never an unfiltered list, no retry inside the request, `trending_dependency_failures_total{dependency}` moves) (T10, FR-010).

### Implementation

- [X] T050 [US2] (S05, D-7, D-12, T05) Implement `D/infra/trending-catalog-facts.adapter.ts` as the anti-corruption layer: `ProductQueryService.getProductsByIds(ids)` first (100 ms budget; no `shopId` option, public data), then `ShopQueryService.getShopsByIds` for the distinct `shopId`s (50 ms); map to `TrendingCatalogFacts` (`id, title, priceMinor, currency, category, status, isSandbox, inStock, shopId`); any throw/timeout → `TrendingUnavailableError`; no `ProductModel`, no raw SQL; import only the entry-point R1 services (D-15 untouched). Bind in `TrendingModule` and confirm `ProductModule`/`TenancyModule` are loaded in `apps/core/src/core.module.ts`.
- [X] T051 [US2] Run `test-spec.sh trending-read` to green (all of R); then `pnpm check:table-ownership --strict` must print no trending line (T05, D-12, AS-38).

---

## Phase 8: User Story 6 — Observable, bounded, safe to operate (P2)

**Goal**: platform guarantees. **Independent test**: `trending-platform.e2e-spec.ts` (P).

### Tests first (`D/trending-platform.e2e-spec.ts`, `describe('Trending degradation, metrics and boundary')`)

- [X] T052 [US6] Create the file with AS-36 (all metrics from T011 exist after scenarios, labels are fixed enums, `trending_last_merge_timestamp_seconds` moves on a merge, no visitor/buyer/order ids, raw bodies or unbounded label values in logs or `/metrics`) (T35, FR-025, SC-008).
- [X] T053 [US6] Add AS-37 boot test (start with one invalid `TRENDING_*` value → startup fails naming the key) and AS-39 (every aggregate and merge key has a TTL ≤ retention (3 h max), key names equal `trending-keys.ts` output, the reader touches only the 60 horizon keys, no `KEYS`/`SCAN` command observed) (T31, T34).
- [X] T054 [US6] Add AS-38 (runs `check:boundaries` and `check:table-ownership --strict` as child processes, inspects `index.ts` exports: only `TrendingModule` and `TrendingProjectorModule`, grep that `application/` and `api/` import nothing from `infra/`) (T50, T51, D-6, D-7, D-8, FR-024).
- [X] T055 [US6] Add AS-40 (broker down at start: readiness false, connect failures counted, retry with backoff, no silent run; loop failure/crash → not ready and the injected `ProcessExit` spy called; ready after subscribe) (T32, FR-023).

### Implementation

- [X] T056 [US6] (D-8, T51) Change `D/index.ts:13-19` to export `TrendingModule` and `TrendingProjectorModule` only; remove `TrendingService`, `TrendingConsumer`, `TrendingConsumerModule` exports.
- [X] T057 [US6] (T50) `apps/projector/src/projector.module.ts:3,51` import `TrendingProjectorModule` instead of `TrendingConsumerModule`; `apps/core/src/core.module.ts:10,141` keep `TrendingModule`; fix any other importer found by `grep -rn "TrendingConsumer\|TrendingService" packages/backend`.
- [X] T058 [US6] Run `test-spec.sh trending-platform` to green; fix gaps found in metrics, readiness, boundary.

---

## Phase 9: User Story 7 — Home and product page show it (P2, owned by W02 and S48)

**Goal**: in-repo callers compile and tests pass on the new envelope; the rest is sibling work. **Independent test**: `test-spec.sh libs/composition/bff`, `tsc --noEmit` for web.

- [X] T059 [US7] (T53) Adapt `libs/composition/bff/product-page.service.ts:15,41,69` to type `trending` with the contract type from `trendingResponseSchema` (pass-through, 200 ms optional budget unchanged) and update the stub at `libs/composition/bff/bff.e2e-spec.ts:32` to the envelope; run `test-spec.sh libs/composition/bff` green. The AS-42 composition test stays S48's.
- [X] T060 [US7] (T54) Adapt `packages/web/app/page.tsx:185-247`: import the item/response type from contracts instead of the hand-written `TrendingItem`, read `items`, render money from `priceMinor`/`currency` and `title` as text, fall back to the catalogue on empty `items`, `429`, `503`; remove the "Powered by Count-Min Sketch + top-K heap (SD-32)" copy. Type-check `packages/web`.
- [X] T061 [US7] (T55, T56, AS-41, AS-42) No code here: confirm `gaps.md` "Sibling-spec follow-ups" already lists S48, W02, W02/W03, S39, S50, S36, S33 bullets; add any bullet missing after T059–T060 (e.g. S39: topic key stays `anonymous_id`, `storedAnalyticsEventSchema` was added here if T005 added it). Do not edit sibling specs.

---

## Phase 10: Polish & cross-cutting

- [X] T062 [P] Ops artifacts: confirm `quickstart.md` "Ops artifacts" lists SC-001, SC-006, SC-007, SC-008, SC-009 (none proven by an automated test; SC-002 proven by U8, SC-003 by R, SC-004 by S, SC-005 by U7) and that `specs/UNVERIFIED.md` already has the five S35 rows with status `not run` (rows at lines 77-81). Add nothing as verified; fix wording only if missing.
- [X] T063 Run static gates from `packages/backend`: `pnpm exec tsc --noEmit` (also `packages/contracts`, `packages/web`), ESLint on touched files, `pnpm check:boundaries`, `pnpm check:table-ownership --strict` (no trending line, AS-38). Confirm `grep -rn "sequelize.transaction" D/*trending* ` and the `// S54 T037 audit` marker count in the domain did not rise.
- [X] T064 Run the whole capability suite once (VII.9): `test-spec.sh libs/domains/discovery/domain`, `trending-stream`, `trending-read`, `trending-platform`, `libs/domains/marketing/ads`, `libs/composition/bff`. Record results honestly; any failure after 5 attempts goes into `questions.md`.
- [X] T065 Final report: list the S05 and S50 follow-ups and how each was handled (T050, T044 for S05; T010, T045 for S50 with "nothing to rename"), remaining unverified criteria, and sibling follow-ups.

---

## Gap coverage (every gaps.md item has a task)

| Gap | Task(s) | Gap | Task(s) |
|---|---|---|---|
| T01 | T004, T039, T044 | T31 | T006, T007 |
| T02 | T003, T040, T045 | T32 | T035, T055 |
| T03 | T004 | T33 | T031, T035 |
| T04 | T025/T026, T047, T050 | T34 | T009, T032, T053 |
| T05 | T044, T050, T051 | T35 | T011, T052 |
| T06 | T044, T048 | T40 | T013, T015 |
| T07 | T025, T026 | T41 | T014, T016 |
| T08 | T026, T047 | T42 | T013, T015 |
| T09 | T010, T041, T045 | T43 | T002, T013, T014, T017 |
| T10 | T043, T044, T049 | T44 | T020, T022 |
| T11 | T042, T044 | T50 | T036, T057 |
| T12 | T008, T043, T044 | T51 | T056 |
| T13 | T025, T026, T044 | T52 | T027–T031, T038 |
| T14 | T041, T045 | T53 | T059 (S48) |
| T20 | T027, T034, T035 | T54 | T060 (W02) |
| T21 | T018, T019, T027 | T55 | T061 (sibling) |
| T22 | T020, T022 | T56 | T061 (sibling) |
| T23 | T020, T029, T022 | T57 | T038 |
| T24 | T020, T029, T022 | D-6 | T008, T044, T054 |
| T25 | T030, T035 | D-7 | T050, T054 |
| T26 | T030, T031, T032 | D-8 | T054, T056 |
| T27 | T021, T022, T030, T034 | D-12 | T050, T051 |
| T28 | T023, T024, T027 | Ownership line (C) | T051, T063 |
| T29 | T028, T034 | D-13/15/16 | not S35 lines (no task; T050 keeps D-15 untouched) |
| T30 | T028, T031, T034 | | |

## Dependencies and order

- Phase 1 → Phase 2 (T003–T012) → Phases 3 and 4 (pure logic; independent of each other, parallel [P] tasks within) → Phase 5 (needs 3, 4, T012) → Phase 6 (needs T043 from Phase 5's writer/keys and the stream to fill data) → Phase 7 (extends Phase 6 service) → Phase 8 (needs 5, 6, 7) → Phase 9 (needs T004) → Phase 10.
- Within every phase: tests (red) → implementation (green). Story priorities: US1–US5 are P1, US6–US7 P2.
- Stories US3/US4 are pure and independently testable; US5 depends on them; US1/US2 read path depends on the Phase 5 writer for end-to-end data but its tests may seed through the real consumer (T012).

## Parallel examples

- After Phase 2: T013, T014, T017, T018, T020, T023, T025 (distinct spec files) in parallel; then T015/T016, T019, T022, T024, T026.
- T032 and T033; T052 with T059/T060 once their dependencies are green.

## Implementation strategy

- MVP = US1 end to end: Phases 1–2, the pure logic it needs (Phases 3–4), the stream (Phase 5), then Phase 6. Deliver US2 (Phase 7) immediately after, since showing unbuyable products must not ship; US3–US5 are in the MVP path because the stream is the data source. US6–US7 (P2) follow.
- Commit per phase checkpoint with green affected suites.
