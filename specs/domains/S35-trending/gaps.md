# Gaps: S35 — Trending Products (current code versus `spec.md`)

The implementation agent's to-do list. Scope: `packages/backend/libs/domains/discovery/` trending files, their callers and the one test that covers them. Read against [`spec.md`](spec.md) (FR-xxx, AS-xx) and [`questions.md`](questions.md). The code is a draft; where it disagrees with the Interview-Prep notes the notes win.

Files in scope: `api/trending.controller.ts`, `application/trending.service.ts`, `infra/trending.consumer.ts`, `domain/count-min-sketch.ts` (+ `.spec.ts`), `trending.module.ts`, the barrel `index.ts:13-19`, `apps/core/src/core.module.ts:10,141`, `apps/projector/src/projector.module.ts:3,51`, `libs/domains/marketing/ads.e2e-spec.ts:19-21,114-129`, `libs/composition/bff/product-page.service.ts:15,41,69`, `libs/composition/bff/bff.e2e-spec.ts:32`, `packages/web/app/page.tsx:185-247`.

## A. What the current code gets wrong or lacks

### Read path

| # | Gap | Where | Spec |
|---|---|---|---|
| T01 | Response is a bare array with a float `price` and key `id`; no envelope, no `rank`, no `currency`, no `generatedAt` | `trending.service.ts:43` | FR-003, AS-01 |
| T02 | No request validation: `category` is cut to 40 characters (`slice(0, 40)`), has no alphabet (`{`, `}`, `*`, `:` reach the key names), `limit` and `minutes` are not parameters of the route, unknown parameters are accepted | `trending.controller.ts:14-15`, `trending.service.ts:21` | FR-002, AS-03, AS-04 |
| T03 | No `packages/contracts` schema for the request or response (the package has no `src` yet); the web page hand-writes `TrendingItem` | `packages/web/app/page.tsx:185-191` | V.2, VII.6, FR-003 |
| T04 | Visibility is `quantity > 0` only: archived, sandbox and suspended-shop products can trend; category of the product is not checked against the requested category | `trending.service.ts:37` | FR-006, AS-10, AS-11 |
| T05 | Raw SQL on catalog's `Product` and an injected `Sequelize` connection inside `application/` (IX.4, D-12) | `trending.service.ts:3,18,37` | FR-006, FR-024, AS-38 |
| T06 | The hydrated list is cached 30 s (+10 s L1): a stock or price change is shown for up to 40 s at origin | `trending.service.ts:23-45` | FR-007, AS-13 |
| T07 | Equal scores are not ordered (`ranked.sort` by score only; Redis order is the tiebreak) → unstable body | `trending.service.ts:32` | FR-004, AS-05 |
| T08 | No `rank`; items are dropped after `slice(0, limit)` and a hidden product shrinks the list instead of being replaced (pool = `limit`) | `trending.service.ts:33,43` | FR-006, AS-10 |
| T09 | Rate limiting is switched off (`skipThrottle: true`) | `trending.controller.ts:11` | FR-009, AS-08 |
| T10 | Any Redis or database failure is an unhandled `500`; no timeouts on the union read or the lookup; `?? []` hides a cache failure as an empty list | `trending.service.ts:23-46` | FR-010, AS-14 |
| T11 | No single-flight proof for concurrent cold reads (relies on `getOrLoad`; no test) | `trending.service.ts:23` | FR-007, AS-15 |
| T12 | `application/` imports an `infra/` class (`WINDOW_MS`, `windowKey` from `../infra/trending.consumer`) and talks to the Redis client directly (`ZUNION`) instead of a `domain/` port; it reads `Date.now()` | `trending.service.ts:4,6,26,29` | I.2, I.3, III.1 (debt D-6), FR-028 |
| T13 | The window set is computed as the last 60 minute boundaries including the current, still-open minute; the 60-window horizon is not tested at boundaries | `trending.service.ts:26-28` | FR-004, AS-18 |
| T14 | No explicit error response shapes (`validation_failed`, `rate_limited`, `trending_unavailable`), `Cache-Control: no-store` on errors, or `Retry-After` | controller | FR-008, FR-010, AS-09 |

### Counting (consumer)

| # | Gap | Where | Spec |
|---|---|---|---|
| T20 | Raw kafkajs consumer built in `infra/` with a hand-rolled loop; no zod validation: `JSON.parse` with an empty `catch` swallows every malformed message, no dead-letter, no counter (IV.5, VII.4) | `trending.consumer.ts:42-45,56-59` | FR-011, FR-021, AS-30 |
| T21 | The stored event's `ts` is parsed as a string (`Date.parse(ts.replace(' ', 'T') + 'Z')`); an unparsable value yields `NaN` and a bogus window; `received_at` is ignored | `trending.consumer.ts:67-71` | FR-012, AS-20, AS-30 |
| T22 | Event time is the client's `ts`; the watermark follows the largest `ts` seen, so one forged future timestamp closes every open window and makes real events late | `count-min-sketch.ts:118-135` | FR-012, AS-20 |
| T23 | No idle handling: a quiet partition never advances its watermark, its windows never close, its counts never become visible | `count-min-sketch.ts:133-146`, consumer | FR-013, AS-21 |
| T24 | Late events are dropped (`stateFor` returns `null`); there is no correction path (the notes require one); `lateEvents` is a public field, not a metric | `count-min-sketch.ts:109,121-124`, `trending.consumer.ts:72` | FR-014, AS-19 |
| T25 | At-most-once: offsets are resolved and committed after each batch (`resolveOffset`, `commitOffsetsIfNecessary`) although windows stay open for up to 3 minutes, so a crash or deploy loses their counts (the header comment accepts it) | `trending.consumer.ts:23-27,60-63` | FR-020, AS-32 |
| T26 | The merge is a bare `ZINCRBY` pipeline: replaying a window (after a restart) would double count; `pipeline.exec()` results are not checked, so a failed command is silently lost; no timeout; a partial failure leaves a half-merged window | `trending.consumer.ts:86-93` | FR-019, FR-022, AS-31, AS-35 |
| T27 | Sketches are per window and category but not per partition, so a merge cannot be identified by (partition, window, offsets) and cannot be made idempotent or safe across a rebalance | `trending.consumer.ts:15-17,33,73-79` | FR-016, FR-018, FR-019, AS-26, AS-33 |
| T28 | No per-visitor cap: one anonymous script posting `product_view` makes any product trend; no duplicate `event_id` handling | `trending.consumer.ts:67-81` | FR-015, AS-22, AS-29 |
| T29 | Category cardinality is unbounded: every client-supplied `props.category` string gets a sketch (width × depth × 4 bytes) and a heap; no alphabet check | `trending.consumer.ts:73-78` | FR-017, AS-27 |
| T30 | Sketch width is `1 << 14` for every category; the notes say 2^16 × 4 ≈ 1 MB; no memory budget; no backpressure when Redis is down | `trending.consumer.ts:76`, `count-min-sketch.ts:5-8` | FR-016, FR-017, FR-022 |
| T31 | Constants (`WINDOW_MS`, `ALLOWED_LATENESS_MS`, `PER_CATEGORY_K`, `WEIGHTS`, widths) are hard-coded and not validated at startup | `trending.consumer.ts:9-12,76` | FR-026, AS-37 |
| T32 | Connect and subscribe failures are swallowed (`.catch(warn)`, `.catch(() => undefined)`); `consumer.run` errors only log; the process keeps running with no consumer and readiness never says so (VIII.3) | `trending.consumer.ts:43-45` | FR-023, AS-40 |
| T33 | `onModuleDestroy` calls `flush(true)` (merge of every open window with the same non-idempotent `ZINCRBY`) and disconnects; offsets of those windows are not committed together with the merge | `trending.consumer.ts:48-51` | FR-020, AS-34 |
| T34 | Window aggregates expire after a fixed 2 h set with `EXPIRE` on every flush; no merge record; retention is not tied to the horizon plus correction horizon | `trending.consumer.ts:90` | AS-39 |
| T35 | No metrics at all (events by outcome, merges, last-merge time, lag, memory); only `Logger.warn/error` | consumer, service | FR-025, AS-36, SC-008 |

### Pure logic (domain)

| # | Gap | Where | Spec |
|---|---|---|---|
| T40 | Counters are `Uint32Array` cells updated with `+=`: they wrap silently at 2^32 instead of saturating | `count-min-sketch.ts:16,23` | FR-016, AS-28 |
| T41 | Heap tie order uses `localeCompare` (locale dependent) | `count-min-sketch.ts:68` | AS-24 |
| T42 | The sketch cannot be merged with another sketch of equal dimensions (no `merge`); the spec's mergeability property has no implementation | `count-min-sketch.ts:9-34` | AS-23 |
| T43 | Unit tests use `Math.random` (flaky precision and bound checks), assert only "≥ 9 of 10" with no seed, and have no cases for heap eviction order, in-place update, ties, watermark rules, idle advance, correction classification, saturation, or the per-visitor cap | `count-min-sketch.spec.ts:10,23,29-30` | VII.5, AS-23 to AS-25, AS-28 |
| T44 | `TumblingWindows` is a generic class with a public mutable counter and reads no clock (good) but has no idle advance and no correction classification | `count-min-sketch.ts:106-147` | FR-013, FR-014 |

### Module, tests and callers

| # | Gap | Where | Spec |
|---|---|---|---|
| T50 | Two modules in one file; the consumer module has no explicit imports and exports the consumer class; apps wire `TrendingConsumerModule` | `trending.module.ts:8-14`, `apps/projector/src/projector.module.ts:3,51` | FR-024, AS-38 |
| T51 | The barrel exports `TrendingService`, `TrendingConsumer`, `TrendingConsumerModule` (infrastructure internals, debt D-8; S32 A29) | `index.ts:13-14,19` | AS-38 |
| T52 | There is no `trending-*.e2e-spec.ts` in `discovery`. The only coverage is a case inside the marketing ads e2e that imports `TrendingConsumer` and `TrendingService` from the barrel, calls `consumer.ingest(...)` and `consumer.flush(true)` directly (no stream, no HTTP, no 4xx, no cache, no visibility) and asserts only titles | `libs/domains/marketing/ads.e2e-spec.ts:19-21,114-129` | VII.2–VII.4, VII.8 |
| T53 | BFF composition expects `trending: unknown[] | null` from `GET /trending?category=`, with a 200 ms budget; its e2e stubs `[]` | `product-page.service.ts:15,41,69`, `bff.e2e-spec.ts:32` | AS-42, FR-027 (S48) |
| T54 | The home page reads the bare array and `price`, hand-writes the type, and prints "Powered by Count-Min Sketch + top-K heap (SD-32)" to buyers | `packages/web/app/page.tsx:185-203,235` | AS-41, FR-027 (W02) |
| T55 | Nothing in the web app or the edge worker emits `product_view` / `add_to_cart` with `props.product_id` and `props.category` (the edge worker only validates and forwards them), so the ranking never fills outside tests | `packages/web` (no emitter), `packages/edge-be/src/index.ts:255-308` | S39 / W02 / W03 contract |
| T56 | No UI journey for the home trending section (`packages/web/tests/search.spec.ts:4` only mentions the fallback) | `packages/web/tests` | AS-41 |
| T57 | `ads.e2e-spec.ts` mixes trending and sponsored clicks (`describe('Trending & sponsored clicks (e2e)')`); S36 must not inherit the trending case | `ads.e2e-spec.ts:27` | traceability (VII.8) |

## B. Open debt-register rows that name `discovery` or S35

| Row | What applies to S35 | Replaced by |
|---|---|---|
| D-6 (I.2, layering) | `application/trending.service.ts:6` imports an `infra/` class and `:4,:18` inject the Redis client and the Sequelize connection directly; the controller is fine | Ports in `domain/` (`TrendingAggregateReader`, `TrendingAggregateWriter` or equivalent) with adapters in `infra/`; the application service depends on port tokens only |
| D-7 (IX.4, `*Model` imports) | No `MODEL` line for the trending files today (`pnpm --dir packages/backend check:table-ownership`). The other `discovery` MODEL lines (`ProductModel` in recommendations, search-reindex and their modules) belong to S34 and S32 | Nothing to replace here; keep it at zero |
| D-8 (X.4, barrel exports internals) | `index.ts:14,19` export `TrendingService` and `TrendingConsumer`; apps wire `TrendingConsumerModule` | Apps import `TrendingModule` and `TrendingProjectorModule` only; the service, consumer, key helper, sketch and window classes leave the barrel (AS-38) |
| D-12 (IX.4, raw SQL on another domain's table) | `application/trending.service.ts` — `SQL Product owned by catalog` (the one trending line in the check output) | **R1**: `ProductQueryService.getProductsByIds` (S05), one batch of the candidate pool, plus **R1** `ShopQueryService.getShopsByIds` (S03) for shop status; no R3 product copy (pool ≤ 60) |
| D-15 (X.5, catalog → discovery cycle) | Not an S35 line (the cycle is catalog's `SearchQueryLogger`, S32). Do not add a discovery → catalog import beyond the entry-point R1 services | S32 / S05 |
| D-16 (X.3, product-index adapter in infrastructure) | Not an S35 line | S32 |
| D-13 | resolved (batch 5): `murmur3` now comes from `libs/common/core/murmur3.ts` (`count-min-sketch.ts:1`) | — |

## C. `pnpm --dir packages/backend check:table-ownership` — discovery lines (run during spec writing)

```
discovery  (7)
  SQL   Product      owned by catalog   libs/domains/discovery/application/shop-product-search.service.ts   ← S32
  SQL   Product      owned by catalog   libs/domains/discovery/application/trending.service.ts              ← S35
  MODEL ProductModel owned by catalog   libs/domains/discovery/application/recommendations.service.ts      ← S34
  MODEL ProductModel owned by catalog   libs/domains/discovery/application/search-reindex.service.ts        ← S32
  MODEL ProductModel owned by catalog   libs/domains/discovery/recommendations.module.ts                    ← S34
  MODEL ProductModel owned by catalog   libs/domains/discovery/search-admin.module.ts                       ← S32
  MODEL ProductModel owned by catalog   libs/domains/discovery/search-reindex-worker.module.ts              ← S32
```

S35's line (1 of 7): `SQL Product` in `trending.service.ts` → R1 `getProductsByIds` (S05) and `getShopsByIds` (S03), as in section B. Done when `pnpm --dir packages/backend check:table-ownership --strict` prints no line for any trending file (AS-38).

## D. Order of work

1. Add `packages/contracts` schemas (`trendingQuerySchema`, `trendingResponseSchema`, `storedAnalyticsEventSchema` from S39), the `discovery.trending` policy in S50's registry, and the configuration schema (T31, AS-37).
2. Pure logic first, under unit tests with a fixed seed: sketch saturation and merge, heap tie order, windows with idle advance and correction classification, event normalisation, per-visitor cap, serving window arithmetic and ranking (T40-T44, AS-05, AS-16 to AS-25, AS-28, AS-37).
3. Rewrite the consumer around per-partition state, zod validation and dead-lettering, idempotent merges with the commit floor, readiness and shutdown (T20-T35, AS-26 to AS-35, AS-40) with `trending-stream.e2e-spec.ts`; move the case out of `ads.e2e-spec.ts` (T52, T57).
4. Rewrite the read path: ports, validation, R1 lookups, ranking cache, errors, rate limit (T01-T14, AS-01 to AS-15) with `trending-read.e2e-spec.ts`; update the barrel and the app modules (T50, T51, AS-38) with `trending-platform.e2e-spec.ts`.
5. Hand the new envelope to S48 (T53) and W02 (T54, T56) and the event emission to W02/W03/S39 (T55) through their own specs.
6. Run the VII.1 static gates and record the green run of the affected suites (VII.9).

## Sibling-spec follow-ups

- **S48**: adopt the `trendingResponseSchema` envelope in `libs/composition/bff/product-page.service.ts` (the `trending` field), keep the 200 ms optional budget, pass items through unchanged, and own the AS-42 composition test; this plan only adapts the in-repo type and the `bff.e2e-spec.ts` stub so the build stays green.
- **W02**: render "Trending now" from `priceMinor`/`currency`, fall back to the catalogue on empty `items`, `429`, `503`; remove the "Powered by Count-Min Sketch…" copy; own `packages/web/tests/home-trending.spec.ts` (AS-41, T56). `packages/web/app/page.tsx` is only type-adapted here.
- **W02 / W03**: emit `product_view` (product page) and `add_to_cart` (cart action) with `props.product_id` and `props.category` through the S39 ingestion (T55); until then the ranking only fills with synthetic events.
- **S39**: publish `storedAnalyticsEventSchema` in `packages/contracts` (this plan adds it only if absent, with the shape in `spec.md` "Requires") and keep the topic key `anonymous_id` (the per-visitor cap relies on it) and the `YYYY-MM-DD HH:mm:ss.SSS` UTC timestamps.
- **S50**: `discovery.trending` (300/min, key `ip`, fail open) is declared in `discoveryRatePolicies` (S32's table, `libs/domains/discovery/rate-limit-policies.ts`); the registry needs no other change. G-35 lists no mis-used policy at a trending call site.
- **S36**: nothing to adopt; its `ads.e2e-spec.ts` loses the trending case and its `TrendingConsumer`/`TrendingService` imports (the file is edited here by hand, only those lines).
- **S33**: no change; no `trending` autocomplete source is added.

## Gate repairs

- **AS-41 / AS-42 had no test carrying their ID.** Added `S35 AS-41` in `trending-read.e2e-spec.ts` (the API half the home page renders: dataset T order, `priceMinor`, `currency`, product id for the link, empty window = 200 with no items; the browser journey stays W02's) and `S35 AS-42` in `libs/composition/bff/bff.e2e-spec.ts` (trending is an optional section: slow or failing gives `trending: null` with the other sections intact; success passes the body through unchanged). The BFF stub now returns the real envelope. Both pass.
- **Test-integrity count on `marketing/ads.e2e-spec.ts` (16 < 18 at HEAD): fixed.** The old trending case had been removed from that file because the in-process `TrendingConsumer.ingest/flush` no longer exists. It is back in the same file under the same title, rewritten against the S35 stack (`createTrendingApp` + `seedDatasetT`: real topic, consumer and `GET /api/trending`; asserts the weighted order B 35 > A 30 > C 3 and the scores). The file's describe title and test count are as at HEAD again; `check-tests.py integrity` passes and `ads.e2e-spec.ts` is 5/5 green.
- **Dependency-cruiser `x4-other-domain-entry-point-only` failed: `marketing/ads.e2e-spec.ts → discovery/testing/trending.fixtures.ts`.** The restored trending case (above) must stay in the ads file (test-integrity count), and it needs S35's fixtures. Fixed in `packages/backend/.dependency-cruiser.cjs` by splitting the rule in two: production code stays strict (index.ts only, no `testing/` kits); spec files may additionally import another domain's `libs/domains/<d>/testing/` kit, the same test-only kits `x6` already lets specs use and that the payments index comment names as the way specs reach another domain. No test was moved, weakened or deleted. `pnpm check:boundaries` is clean, `tsc` is clean, `ads.e2e-spec.ts` stays green.
- The remaining AS-36, AS-38, AS-39, AS-40 reported by `check-tests.py` without `MAX_PRIORITY` belong to User Story 6 (P2), deferred below.

## Deferred until a later pass

Lower-priority stories (P2) were not started in the P1 pass; every scenario below is deferred, not failed.

- **US6, observable and safe to operate** (tasks T052-T058; AS-36, AS-37 boot test, AS-38, AS-39, AS-40): waits for no other capability. AS-37 is already covered at unit level (`trending-config.spec.ts`). Two of its code tasks were needed in the P1 pass and are in place although their boxes stay unticked: the barrel exports `TrendingModule` and `TrendingProjectorModule` only (T056) and `apps/projector` imports `TrendingProjectorModule` (T057), because the old `TrendingConsumer`, `TrendingService` and `TrendingConsumerModule` no longer exist. `trending-platform.e2e-spec.ts` is still to be written.
- **US7, home page and product page** (T059-T061; AS-41, AS-42): wait for **W02** (home page rendering and `packages/web/tests/home-trending.spec.ts`) and **S48** (BFF composition test). Interim state: `GET /api/trending` now returns the envelope `{category, windowMinutes, generatedAt, items}`, while `packages/web/app/page.tsx` and `libs/composition/bff/product-page.service.ts` still read the old bare array until the P2 pass adapts them.
- **Polish (T062-T065)**: left for the final full pass. The ops artifacts are already listed in `quickstart.md` and `specs/UNVERIFIED.md` (status "not run").
- **Not provable at the API layer**: AS-08 "another address is unaffected" (a spec cannot change the address of a request; the per-address keying of the limiter is S50's test).

## Implementation notes (decisions taken while building)

- **The correction path is atomic and keyed by event id.** The plan's separate `CorrectionDedupe` port (`SET trending:seen:{id} NX` before buffering) would lose a late event if the process died between the claim and the merge. Instead the correction merge script claims each `trending:seen:{eventId}` and adds the event in the same atomic step (`redis-trending-aggregate.adapter.ts`, `mergeCorrections`). Key names, TTL and counters are as specified; the port and adapter named in T008 and T033 are therefore not created.
- **State is dropped on every rebalance** (`TrendingIngestService.reset()`): the group resumes from the committed floors, so the replay rebuilds the open windows exactly as after a restart, and the idempotent merge makes rebuilt windows harmless. Keeping memory across a rebalance would count replayed events twice.
- **Ignored events still move time.** A valid `page_view`, or a product event without `product_id`, is not counted, but its times feed the watermark and the idle clock; an invalid timestamp is dead-lettered whatever the name.
- **AS-16 versus AS-30 on `product_id`:** a product event without `product_id` is `ignored` (AS-16); one whose `product_id` is not a UUID is `invalid` and dead-lettered (AS-30). T018 in `tasks.md` groups both as ignored; the acceptance scenarios decide.
- **Windows close when the watermark reaches the window end** (AS-17). The AS-19(a) example (an event at 12:09:30 with watermark 12:10:00) is exercised with watermark 12:09:59, where that window is still open.
- **The heap order is total** (count descending, key ascending by code unit), so equal estimates give the same heap on every replay.
- **Layout:** metrics live in `application/trending-metrics.ts` and settings reach the application through the `TRENDING_SETTINGS` token, so `application/` and `api/` import nothing from `infra/` (AS-38). `rankCacheKey` is defined next to the pure ranking and re-exported by `infra/trending-keys.ts`. Fixtures are in `testing/trending.fixtures.ts` (boundary rule `x6` forbids test imports outside `testing/`).
- **Follow-ups treated as requirements:** S05 (no `JOIN "Product"`, `ProductModel` or raw SQL; one `getProductsByIds` and one `getShopsByIds` per request; no injected `Sequelize`) and S50 (`discovery.trending` declared, `@RateLimit` replaces `skipThrottle`; nothing to rename, G-35 lists no trending call site).
