# Test Plan: S35 — Trending Products (domain `discovery`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (42 scenarios, AS-01 to AS-42), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. Where a row names two layers, each proves a different part of the scenario (stated in the cell); no part is proven twice.

- API e2e files live in `packages/backend/libs/domains/discovery/`. Each file's top-level `describe` names its feature (VII.8). They boot the real feature modules (`TrendingModule`, `TrendingProjectorModule`, plus the real `ProductModule` and `TenancyModule` that provide the R1 services) with the production global pipe, filter, prefix and interceptors, call them through `supertest`, and run against real Redis, Kafka (stand-in) and Postgres from `docker-compose.test.yaml` with real migrations applied. The consumer is driven by producing real analytics messages to the real topic (or delivering them through the consumer's batch handler where a test needs a precise partition, offset or crash point) and a real dead-letter store. No test calls a consumer-internal method such as `ingest` or `flush` directly (the existing `marketing/ads.e2e-spec.ts:114-129` does; its trending case moves here).
- Only system-edge dependencies are faked or spied: the access-token verifier (AS-07), time (frozen; the clock is advanced explicitly for AS-18, AS-21), and, to force a fallback path (VII.9), a failure or delay injected on the Redis client (AS-14, AS-35) and on the R1 services (AS-14). The aggregate store, sketches, windows, merge records, cache and serving service are real. Call-count assertions (AS-04, AS-10, AS-15) use a counting wrapper around the real Redis client and the real R1 services, not a stub. Every test asserts the response **and** the persisted effect (aggregates and their TTLs, merge records, committed offsets, dead-letter rows, metrics, spy counts) and resets state first (`clean()`, flush of the trending keyspace, a fresh consumer group id).
- Every e2e parses `200` bodies with `trendingResponseSchema` and error bodies with the problem schema from `packages/contracts` (VII.6). Dataset T is a shared fixture (`trending.fixtures.ts`) that produces its events through the real topic and the real consumer.
- VII.4 pair for the consumer: AS-29 (duplicate delivery → one effect) and AS-30 (invalid payload → dead-lettered, no side effect), both in the stream e2e file.
- "Two consumer instances" (AS-33) are two real consumer modules in one test process; a crash (AS-31, AS-32) is a consumer stopped without its shutdown hooks (no final merge, no commit); concurrent merges (AS-33) are two real merges with `Promise.all`.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5). Randomised inputs come from a fixed seed (no `Math.random`). AS-05, AS-22 and AS-25 also get a `fast-check` property. No unit tests for controllers, repositories, the consumer loop, merge scripts or glue.
- UI journey (Playwright, owned by W02, happy path only): `packages/web/tests/home-trending.spec.ts`. No server edge case is re-tested in the browser (VII.7).
- Static gates (VII.1, AS-38): `tsc --noEmit` and ESLint for `packages/backend`, `packages/contracts`, `packages/web`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict`.
- The latency proof of SC-007, the throughput proof of SC-009 and the memory proof of SC-006 are operations artifacts (`loadtest:trending`, a replay of 10M synthetic events comparing the approximate with the exact top-K), not e2e rows.
- Fallback paths (VII.9) each have a test that forces them: aggregate store or lookups down and slow (AS-14), store down during a merge (AS-35), event broker down at start (AS-40), idle partition (AS-21), cache miss path under concurrency (AS-15), correction path (AS-19).

Abbreviations for the e2e files (all under `libs/domains/discovery/`):

| Key | File | Top-level `describe` |
|---|---|---|
| R | `trending-read.e2e-spec.ts` | `Trending products API` |
| S | `trending-stream.e2e-spec.ts` | `Trending streaming aggregation` |
| P | `trending-platform.e2e-spec.ts` | `Trending degradation, metrics and boundary` |
| X | `libs/composition/bff/bff.e2e-spec.ts` (owned by S48) | `BFF product page composition` |
| W | `packages/web/tests/home-trending.spec.ts` (owned by W02) | `Home trending section` |

Unit files (all under `libs/domains/discovery/domain/`): `count-min-sketch.spec.ts` (U1), `top-k.spec.ts` (U2), `tumbling-windows.spec.ts` (U3), `trending-ranking.spec.ts` (U4: ranking order, tie-break, candidate pool, serving window arithmetic), `trending-event.spec.ts` (U5: event normalisation, weights, event time, category validity), `trending-config.spec.ts` (U6), `visitor-cap.spec.ts` (U7), `trending-accuracy.spec.ts` (U8: seeded stream, precision against the exact top-K).

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 happy path, headers, schema parse, no state change (dataset T through the real consumer) | R | — | — |
| AS-02 default category and `all`, catalog category in items | R | — | — |
| AS-03 `limit` default, bounds and invalid values | R | — | — |
| AS-04 validation problem+json shape, category alphabet and length, unknown parameter, no store consulted | R | — | — |
| AS-05 order, ties and replay | — | — | U4 (ties by `productId`, byte-identical output, ranks without gaps; property: order independent of input order) |
| AS-06 no traffic or unknown category → `200` empty | R | — | — |
| AS-07 same body for every caller, invalid token ignored, no cookie or `Vary`, log and label content | R | — | — |
| AS-08 rate limit 429 and fail-open | R | — | — |
| AS-09 errors are `no-store` (400, 429; the 503 header is asserted in AS-14) | R | — | — |
| AS-10 hidden candidates dropped and replaced, pool size, batched lookups (call counts) | R | — | — |
| AS-11 catalog category is authoritative | R | — | — |
| AS-12 fewer than asked, all hidden | R | — | — |
| AS-13 stock and price change seen at origin immediately | R | — | — |
| AS-14 aggregate store or lookup failure and timeout → 503 | R (fault injection) | — | — |
| AS-15 concurrent cold reads share one computation | R (`Promise.all`, call count) | — | — |
| AS-16 weights and ignored names, missing `product_id` | — | — | U5 (`it.each` over event names and props) |
| AS-17 event time, out-of-order, watermark close | — | — | U3 (table of event times and watermarks; visibility itself is shown by AS-01) |
| AS-18 the last hour slides (window set at 11:59:20, 12:01:05, 12:02:05) | — | — | U4 (window arithmetic over frozen instants) |
| AS-19 late events: within lateness, correction path, dropped | S (correction merge applied once and visible; `late_dropped` counter) | — | U3 (classification: open, closed-in-horizon, beyond horizon) |
| AS-20 wrong clock cannot move time | — | — | U5 (event time = earlier of `ts` and `received_at`) and U3 (watermark never ahead of newest `received_at − lateness`) |
| AS-21 idle partition closes by the wall clock | S (quiet partition becomes visible with no later event; a busy partition is not advanced) | — | U3 (idle advance rule) |
| AS-22 one visitor, one vote per window | — | — | U7 (cap per visitor, name, product, window; property: no false "unseen"; false "seen" rate ≤ 1% on a seeded stream) |
| AS-23 Count-Min Sketch: never undercounts, error bound, mergeable, fixed size | — | — | U1 (seeded Zipf stream; `it.each` over widths and depths; property: estimate ≥ exact, merge equals whole) |
| AS-24 min-heap of K heaviest, in-place update, tie order | — | — | U2 (the worked table; property: heap equals the K largest of an exact count) |
| AS-25 accuracy of the approximation (precision ≥ 0.9, seeded) | — | — | U8 |
| AS-26 multi-level merge across partitions | S (two partitions, sums, product in only one top-K) | — | — |
| AS-27 category cap, rejected categories, memory budget | S (1,000 categories, 10,000 products; counters; tracked memory gauge) | — | — |
| AS-28 counters saturate, never wrap | — | — | U1 |
| AS-29 duplicate delivery → one effect (same batch, different batches, after a restart) | S | — | — |
| AS-30 invalid payload → dead-lettered, no side effect, partition not blocked | S | — | — |
| AS-31 replayed merge changes nothing (crash after merge, before commit) | S | — | — |
| AS-32 crash loses nothing (compare with an uninterrupted run; committed offsets) | S | — | — |
| AS-33 partition moves and concurrent owners | S | — | — |
| AS-34 graceful shutdown merges and commits | S | — | — |
| AS-35 aggregate store down during a merge: retry, no commit, backpressure, all-or-nothing | S (fault injection on the Redis client) | — | — |
| AS-36 metrics exist with bounded labels; no identifiers in logs | P | — | — |
| AS-37 configuration validated at startup | — | — | U6 (`it.each` over each invalid setting; the startup failure itself is asserted once in P by booting with a bad value) |
| AS-38 module boundary: ownership strict, boundaries, exports, no `infra/` import from application | P (runs the static checks and inspects the entry point's exports) | — | — |
| AS-39 retention TTL, computed key names, horizon read limit | P | — | — |
| AS-40 consumer never silently dead: broker down at start, loop failure, readiness and exit | P | — | — |
| AS-41 home page "Trending now" happy path and fallback to the catalogue | — | W | — |
| AS-42 BFF composition boundary: optional, 200 ms budget, pass-through | X (owned by S48) | — | — |
