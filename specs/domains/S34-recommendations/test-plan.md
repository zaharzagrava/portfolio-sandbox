# Test Plan: S34 — "Bought Together" Recommendations (domain `discovery`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (51 scenarios, AS-01 to AS-51), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/discovery/`. Each file's top-level `describe` names its feature (VII.8). They boot the real feature modules (`RecommendationsModule`, `RecommendationsWorkerModule`, `RecommendationsProjectorModule`, plus the real `ProductModule` and `TenancyModule` that provide the R1 services) with the production global pipe, filter, prefix and interceptors, call them through `supertest`, and run against real Redis, ClickHouse and Postgres from `docker-compose.test.yaml` with real migrations and the real ClickHouse DDL applied. The projector is driven by delivering real envelopes through the projection runner and a real dead-letter store.
- Only system-edge dependencies are faked or spied: the access-token verifier (AS-07), time (frozen), and, to force a fallback path (VII.9), a failure or delay injected on the Redis client, the ClickHouse client (AS-40) and the R1 services (AS-46). The basket store, neighbour lists, build job, lock and serving service are real. Command-count assertions (AS-15, AS-16, AS-20) use a counting wrapper around the real Redis client, not a stub. Every test asserts the response **and** the persisted effect (baskets, lists, TTLs, dead-letter rows, metrics, spy counts) and resets state first (`clean()`, `TRUNCATE order_baskets`, flush of the list keyspace).
- Every e2e parses `200` bodies with `recommendationsResponseSchema` and error bodies with the problem schema from `packages/contracts` (VII.6). Dataset D is a shared fixture (`recommendations.fixtures.ts`).
- The build is driven through the real job handler `recommendations.build-bought-together` and the real job table. "Two worker instances" (AS-44) is two real worker modules in one test process; overlapping builds (AS-41) are two real handler invocations with `Promise.all`.
- VII.4 pair for the consumer: AS-30 (duplicate delivery → one effect) and AS-31 (invalid payload → dead-lettered, no side effect), both in the basket e2e file.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5); AS-02 and AS-17/AS-18 also get a `fast-check` property (output order is a total order independent of input order; best-path score never decreases when a path is added). No unit tests for controllers, repositories, the lock, the projector or glue.
- UI journey (Playwright, owned by W02, happy path only): `packages/web/tests/product-recommendations.spec.ts`. No server edge case is re-tested in the browser (VII.7).
- Static gates (VII.1, AS-50): `tsc --noEmit` and ESLint for `packages/backend`, `packages/contracts`, `packages/web`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict`.
- The latency proof of SC-001 and the build-time proof of SC-007 are operations artifacts (`loadtest:recommendations`, a build run on the 1B-line fixture), not e2e rows.
- Fallback paths (VII.9) each have a test that forces them: store down and slow (AS-45), lookups down and slow (AS-46), empty source (AS-39), failure midway (AS-40), expired lists (AS-43), lock contention (AS-41).

Abbreviations for the e2e files (all under `libs/domains/discovery/`):

| Key | File | Top-level `describe` |
|---|---|---|
| R | `recommendations-read.e2e-spec.ts` | `Bought-together recommendations API` |
| N | `recommendations-cold-start.e2e-spec.ts` | `Bought-together 2-hop cold start` |
| B | `recommendations-baskets.e2e-spec.ts` | `Order basket projection` |
| J | `recommendations-build.e2e-spec.ts` | `Co-occurrence nightly build` |
| P | `recommendations-platform.e2e-spec.ts` | `Recommendations degradation, metrics and boundary` |
| X | `libs/composition/bff/bff.e2e-spec.ts` (owned by S48) | `BFF product page composition` |

Unit files (all under `libs/domains/discovery/domain/`): `recommendation-ranking.spec.ts` (U1), `two-hop-blend.spec.ts` (U2), `neighbour-entry.spec.ts` (U3), `cosine-score.spec.ts` (U4), `basket.spec.ts` (U5), `build-params.spec.ts` (U6).

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 happy path, headers, no state change, schema parse (builds dataset D through the real job) | R | — | — |
| AS-02 order, ties and replay | — | — | U1 (ties by `productId`, byte-identical output, property: order independent of input order) |
| AS-03 `limit` default, bounds and invalid values | R | — | — |
| AS-04 `type` accepted and rejected values | R | — | — |
| AS-05 validation problem+json shape, unknown parameter, non-UUID id | R | — | — |
| AS-06 unknown or hidden requested product → identical 404 | R | — | — |
| AS-07 same body for every caller, invalid token ignored, no cookie, log and label content | R | — | — |
| AS-08 rate limit 429 and fail-open | R | — | — |
| AS-09 errors are `no-store` (400, 404, 429; the 503 header is asserted in AS-45) | R | — | — |
| AS-10 hidden candidates dropped and replaced, batched lookups (call counts) | R | — | — |
| AS-11 fewer than asked, none visible | R | — | — |
| AS-12 stock change seen at origin immediately | R | — | — |
| AS-13 2-hop expansion on the cold product (dataset D, `S`) | N | — | — |
| AS-14 hub filled by expansion (dataset D, `P`) | N | — | — |
| AS-15 expansion bounded: top 5 seeds, one batch, no third hop (command counts) | N | — | — |
| AS-16 no expansion when the direct list suffices (1 read) | N | — | — |
| AS-17 best path wins; direct stays direct; no self | — | — | U2 (table of graphs; property: adding a path never lowers a score) |
| AS-18 direct before indirect despite lower score | — | — | U2 |
| AS-19 hidden seed still bridges | N | — | — |
| AS-20 product with no edges (1 read) | N | — | — |
| AS-21 damaged stored entries skipped | — | — | U3 (non-UUID, self, NaN, negative, > 1, missing score) |
| AS-22 cosine scoring and rounding (dataset D numbers; `n` counts all baskets of the product) | — | — | U4 (`it.each` over dataset D pairs; property: symmetric, in (0, 1], 1 only for identical baskets) |
| AS-23 noise threshold (≥ 3 co-orders) | J | — | — |
| AS-24 distinct-buyer threshold, manufactured edge | J | — | — |
| AS-25 symmetry of edges | J | — | — |
| AS-26 window boundary, counts and `n` | J (time frozen) | — | — |
| AS-27 top-20 cap and deterministic ties | J | — | — |
| AS-28 independence from bucket count (1, 4, 16) | J | — | — |
| AS-29 paid order becomes one basket (distinct, sorted, buyer, version) | B | — | — |
| AS-30 duplicate and concurrent delivery → one basket | B | — | — |
| AS-31 invalid payloads dead-lettered, stream continues | B | — | — |
| AS-32 other event types ignored | B | — | — |
| AS-33 basket size rule (1, 2, 30, 31 distinct; repeated lines) | — | — | U5 |
| AS-34 late, reordered, stale-window and version-guarded redelivery | B | — | — |
| AS-35 topic replay rebuilds identical baskets and lists | B | — | — |
| AS-36 idempotent rerun | J | — | — |
| AS-37 atomic list replacement under concurrent readers (50 readers, repeated) | J | — | — |
| AS-38 product that lost all edges loses its list; failed build removes nothing | J | — | — |
| AS-39 empty source → `skipped_empty`, nothing written or removed | J | — | — |
| AS-40 failure midway (injected on the 3rd bucket query) leaves valid lists, no deletion, no success timestamp | J | — | — |
| AS-41 concurrent builds → one works, one `skipped_locked`; lock expiry by lease | J | — | — |
| AS-42 job parameter validation and defaults | — | — | U6 |
| AS-43 lists carry a 3-day lifetime; expired list → empty answer (expiry simulated by deleting the key at the TTL boundary; TTL value asserted) | J | — | — |
| AS-44 schedule registered exactly once across two workers and a restart | J | — | — |
| AS-45 store down or slow → 503 `recommendations_unavailable`, headers, no leak, no in-request retry | P | — | — |
| AS-46 product or shop lookup failure or timeout → same 503, never an unfiltered list | P | — | — |
| AS-47 metrics set and log content | P | — | — |
| AS-48 product page shows the rail; hidden when empty | — | `packages/web/tests/product-recommendations.spec.ts` (W02) | — |
| AS-49 composition: slow, 503, 404 and invalid body from the recommendations API → partial page (R2, owned by S48) | X | — | — |
| AS-50 module boundary and ownership gates (static, run in CI) | P (asserts the module's exports and registry) | — | — |
| AS-51 configuration validation fails startup | P | — | — |
