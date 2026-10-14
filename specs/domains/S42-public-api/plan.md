# Implementation Plan: S42 — Seller public API (API keys, scopes, sandbox, date-pinned versions, deprecation headers, batch, request logs) — domain `developer-platform`

**Branch**: `S42-public-api` | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md` (v3.1.0). Design artifacts: [research.md](research.md), [data-model.md](data-model.md), [contracts/http.md](contracts/http.md), [contracts/events.md](contracts/events.md), [contracts/services.md](contracts/services.md), [quickstart.md](quickstart.md).

## Summary

Today's `developer-platform` public API (≈ 1,400 lines for S42's share) works for the happy path but: falls back to the JWT secret as key pepper, rotates revoked keys, races revoke against the cache, has no key limit or lifecycle events, runs raw SQL on `Product`, `Shop`, `ShopOrder`, `BisOrder`, `BisOrderItem` and `ShopApiSettings`, overwrites stock with absolute values, loses updates on `PATCH`, pins nobody (latest at every call), downgrades responses only, announces one deprecated route forever, validates batch operations not at all, keeps bulk-job state in a 24 h Redis hash that double counts redelivered chunks, never emits `usage.recorded`, loses request records silently and logs nothing for guard failures. S42 replaces it with:

- **Pure rules in `domain/`**: `key-status`, `version-registry`/`versioning` (both directions), `deprecation`, `sparse-fields`, `bulk-chunking`, `usage-bucket`, `batch-plan`, ports (G-45, D-6).
- **Conditional statements for every key transition** (R-02): limit under a per-shop row lock, one-winner rotate, idempotent revoke, events in the same transaction; a revoke **tombstone** plus fill-if-absent closes the cache race (R-03); a dedicated, required pepper with re-hash on use.
- **R1 services only** (R-12): S03 `ShopProvisioningService`/`ShopQueryService`, S05 `ProductCommandService`/`ProductQueryService`/`ProductStockService`, S10 `OrderQueryService` (+ additive `getShopOrder`); no query on another owner's table (D-12, D-7).
- **One version registry** with lifecycle, request upgraders and response downgraders; pinned once at the first key (R-06); deprecation headers and `410` driven by the injected clock on every response (R-07).
- **One request record per authenticated call**, built from the final response by a middleware, with a bounded buffer and counted drops (R-07); a deduplicating projector; exact `usage.recorded` from a bucket table (R-08).
- **Durable bulk jobs** with per-chunk markers and idempotent chunk accounting (R-11); delta stock with operation IDs; batch operations validated like routes, with per-operation idempotency and a 10 s budget.
- **Fair use**: required `Idempotency-Key` scoped to acting shop + route, per-request rate-limit cost, auth-failure policy, fail-open quota behind a port (R-09, R-10).
- **Contracts**: problem+json with a stable code catalogue, per-version zod schemas, generated OpenAPI 3.1, OWASP mapping document, safe transport defaults (R-14).

## Follow-ups from already-built specs (each is a requirement, planned and tested here)

See [`gaps.md`](gaps.md) section 5 for the full table (S01 `Firewall({sensitive:true})` and `SecretBox` note; S03 tenancy services and closed-shop answers; S05 command/stock services, legacy `create` refusals and `Unbranded`; S10 `…Minor` money; S50 policies, structured headers, new errors; S53/S54 idempotency store; W07 `openapi.json`; rules 0, 2, 4). Each row names its work package and scenarios. Sibling items other capabilities must adopt are under "Sibling-spec follow-ups" in `gaps.md` (S10, S18, S43, S44, S03, S05, shared idempotency, W04, S28).

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; domain `packages/backend/libs/domains/developer-platform`; schemas `packages/contracts/src/developer-platform`; apps `public-api`, `core`, `worker`, `projector`.

**Primary Dependencies**: all present — `@nestjs/sequelize`, `TransactionRunner`, `OutboxService`/`defineEvent`, S53 consumer runtime and SQS queue port, S49 `declareJobType`/`@JobHandler`, S50 `definePolicies`/`@RateLimit` (with `cost`), S52 `CacheService.getOrLoad`, S54 `CLOCK`/config validation/metrics/shutdown, shared `IdempotencyModule`, `ClickHouseService` (infra only), S03/S05/S10 exported services, zod, `fast-check` (dev), Node `crypto`. **No new library.**

**Storage**: PostgreSQL (`ApiKey`, `ShopApiSettings` reshaped; `ApiBulkJob`, `ApiBulkChunk`, `ApiUsageBucket` new); Redis (key cache, tombstones, shop-status entries, `lastUsedAt` write-behind, limiter, idempotency); ClickHouse (`api_requests`, usage view); Kafka (`api.request_logged`, `tenancy.events`, outbox topics); SQS/ElasticMQ `public-api-bulk-chunk` (+ DLQ).

**Testing**: Jest e2e through `scripts/sdd/test-spec.sh` (ten files from `test-plan.md`), seven table-driven unit specs under `domain/` with `fast-check` properties, wiring specs for the four apps, static gates; real Postgres, Redis, ClickHouse, queue; faults only at system edges (fast store, event producer, limiter store, quota port, queue). UI journey is W04's.

**Target Platform**: Linux; `apps/public-api` (`PublicApiModule`), `apps/core` (`DevelopersModule`), `apps/worker` (`PublicApiWorkerModule`), `apps/projector` (`PublicApiProjectorModule`).

**Project Type**: web-service (backend domain) + contracts package.

**Performance Goals**: 30,000 rps across 100,000 keys, p99 authenticated read < 150 ms (SC-010, ops artifact); hot path = one `MGET` on a cache hit, 0 DB statements, request-record publish off the response path.

**Constraints**: injected clock everywhere (G-43); no network I/O inside a transaction (R1 calls, Redis, Kafka happen outside); secrets never in logs, events, errors, metric labels or traces; shop comes only from the key; 404 for foreign records; logs best effort, usage exact; fail open on limiter and quota, fail closed (`503`) on the key store; every refusal of a credential is the same `401`.

**Scale/Scope**: 12 public routes + 9 dashboard routes (+ 2 OpenAPI routes), 6 produced events, 4 consumed streams, 1 queue, 3 jobs, 2 rate policies, 7 counters, 3 new tables + 2 reshaped, 3 migrations, 8 pure modules, 10 e2e files, 71 acceptance scenarios, 66 requirements, 45 gap items.

### Pool arithmetic and `statement_timeout` (III.12)

No pool is added. Cache-hit verification = 0 statements; miss = 1 indexed read by prefix (+ at most one `getShopsByIds`). Create key = 4 statements in one transaction (settings upsert + `FOR UPDATE`, count, insert, outbox); the row lock is held for ~4 statements (≈ ms) and only serialises creators of the same shop. Rotate = 3, revoke = 2, pin = 2. Chunk apply = 2 statements here + S05's one transaction; the chunk transaction does not hold the S05 transaction open (the marker flips first, stock apply is idempotent per `operationId`, then counters). Usage closer = 2 statements per bucket batch ≤ 500. Purge ≤ 500 rows per statement. `lock_timeout` 3 s on every DDL; request statements use the global `statement_timeout`.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I Layered modules (I.1, I.2) | controllers → one application service each; ports in `domain/`; Sequelize/ClickHouse/Redis only in `infra/` (R-01) | pass |
| II Request pipeline (II.1) | controllers hold no queries; middleware/guards/interceptors/filter have fixed roles; no `@InjectConnection` outside `infra/` | pass |
| III Data access (III.4, III.6, III.7, III.9, III.11, III.12) | shop in every predicate; limits and transitions as conditional statements; cache never source of truth (bulk jobs durable); expand/contract migrations with `lock_timeout`; pool arithmetic above | pass |
| IV Communication (IV.3) | other domains by R1 services and events; no shared table | pass |
| V Contracts (V.2, V.3, V.6) | per-version zod schemas, problem+json with codes, required `Idempotency-Key` | pass |
| VII Testing (VII.1…VII.9) | every AS has a row in `test-plan.md`; concurrency repeated ≥ 20×; consumers have duplicate + invalid tests; five forced-fault tests; contract tests per version; no mocked internals | pass |
| VIII Operational safety (VIII.5) | dedicated pepper, startup fails without it; no secret in logs/events/metrics | pass |
| IX Isolation (IX.4, IX.7) | no cross-owner table or FK; three new tables registered; `check:table-ownership --strict` is a gate | pass (after WP-2, WP-7) |
| X Structure (X.4, X.6) | barrel exports modules, `ApiVersionService`, DTOs; apps import modules | pass |
| Cross-spec rule 4 | 0 direct `sequelize.transaction`, 0 audit comments, none added | pass |
| Lessons L-001…L-019 | applied in research R-16 and `tasks.md` | pass |

**Post-design re-check**: no new violation. The one recorded exception is the shared idempotency module gaining two additive options (G-30 says add them there); it is listed in Complexity Tracking.

## Complexity Tracking

| Violation / exception | Why needed | Simpler alternative rejected because |
|---|---|---|
| Additive change in shared `libs/infrastructure/idempotency` (`required`, `scope`) | FR-049 needs a key scoped to acting shop + route and a required header; the shared interceptor scopes by key id | duplicating an idempotency store here would be a second store (P0414 says one) |
| `OrderQueryService.getShopOrder` added in the orders domain | `GET /v1/orders/:id` needs a shop-scoped single lookup; list-and-filter is wrong, load-then-check is forbidden (III.4) | waiting for S10 leaves AS-42 unprovable; the addition is one statement and is recorded as a sibling follow-up |
| Third scheduled job `public-api.close-usage-minutes` | usage must be emitted after the minute is closed, with sequences for late records | emitting per request adds latency and loses events on crash |
| `QuotaPort` adapter that allows until S18 exports `checkQuota` | S18 is not built; FR-053 fails open anyway | blocking the capability on S18 or computing the quota here duplicates its rule |

## Project structure (target state, `packages/backend/libs/domains/developer-platform`)

```text
domain/
├── api-key-format.ts (+ .spec.ts)         # extended: prefix collision, parse, constant-time compare
├── key-status.ts (+ .spec.ts)             # state machine, assertNever
├── version-registry.ts, versioning.ts (+ .spec.ts)  # one registry, validation, up/down transformers
├── deprecation.ts (+ .spec.ts)            # header values, windows, minimum window
├── sparse-fields.ts (+ .spec.ts)          # fields/expand parsing in requested-version names
├── bulk-chunking.ts (+ .spec.ts)          # split, counters, status
├── usage-bucket.ts (+ .spec.ts)           # minute, billable rule, deterministic event id
├── batch-plan.ts                          # batchable set, cost, budget
├── errors.ts                              # typed ApiError subclasses with catalogue codes
└── ports.ts                               # repositories, KeyCache, RequestLogStore, QuotaPort, gateways, Clock
application/
├── api-keys.service.ts, api-version.service.ts, request-log.service.ts, usage-report.service.ts
├── public-catalog.service.ts, public-orders.service.ts, batch.service.ts, bulk-stock.service.ts
├── shop-lifecycle.handler.ts, usage-metering.handler.ts, bulk-chunk.worker.ts
├── key-usage.flusher.ts, usage.closer.ts, bulk.purger.ts
└── events/api-events.ts                   # + api_key_*, api_version_pinned, request_logged fields
api/
├── api-keys.controller.ts, api-version.controller.ts, logs-usage.controller.ts, openapi.controller.ts
├── v1.controller.ts, batch.controller.ts, bulk-stock.controller.ts
├── api-key.guard.ts, scope.guard.ts, lifecycle.guard.ts, request-context.middleware.ts
└── public-api.interceptor.ts              # version resolve, upgrade/downgrade, cost
infra/
├── sequelize-api-key.repository.ts, sequelize-settings.repository.ts, sequelize-bulk-job.repository.ts, sequelize-usage-bucket.repository.ts
├── redis-key-cache.ts, request-record.sink.ts, clickhouse-request-log.store.ts
├── api-requests.projector.ts              # dedupe + validation
├── r1 adapters: shop-directory.adapter.ts, catalog.gateway.ts, order.gateway.ts, billing-quota.adapter.ts
└── jobs.ts, consumers.ts
developers.module.ts, public-api.module.ts, public-api-worker.module.ts, public-api-projector.module.ts (new)
rate-limit-policies.ts, index.ts
*.e2e-spec.ts                              # the ten files of test-plan.md; public-api.e2e-spec.ts deleted
```

Other paths: `packages/backend/migrations/` (three), `packages/backend/db/ownership.ts`, `infra/docker/elasticmq.conf`, `infra/stack/main.tf`, `packages/contracts/src/developer-platform/`, `libs/infrastructure/idempotency/` (additive), `libs/domains/orders/application/order-query.service.ts` (`getShopOrder`), `apps/{public-api,core,worker,projector}/src/*wiring.e2e-spec.ts`, `docs/spec/capabilities/S42-public-api.md`, `docs/security/owasp-api-top-10.md`, `scripts/load-tests/public-api-mixed.test.js`.

**Structure Decision**: single backend domain plus the contracts package, following the layering of the existing domain and the S24 pattern; no new package.

## Work packages (dependency order; tests first inside each)

| WP | Content | Gaps | Scenarios |
|---|---|---|---|
| WP-0 | Living-spec page `docs/spec/capabilities/S42-public-api.md` (rules first, then code); `[proof]`/`[code]` kept true; `python3 scripts/livespec/check.py` | rule 0 | — |
| WP-1 | Pure domain modules + unit specs (+ properties); typed errors; contracts schemas (per version, keys, logs, usage, problem, events); fixtures (shops, keys, products through exported services; fault wrappers; frozen clock) | G-16, G-17, G-39, G-37 | AS-20, AS-27, AS-31, AS-32, AS-34, AS-38, AS-51, AS-64 (unit halves) |
| WP-2 | Migrations (expand, FK drop, registry), `ownership.ts`, `elasticmq.conf`, `main.tf`, config `api_key_pepper(_previous)`, ClickHouse additive columns | G-42, G-01 (config) | AS-21, AS-70 |
| WP-3 | Keys: repositories, `KeyCache` with tombstone, `ApiKeysService` (create with limit, conditional rotate/revoke, status, events), guard (uniform 401, dummy hash, degraded modes, auth-failure policy), dashboard controllers (`Firewall({sensitive:true})`, `mfa`), `lastUsedAt` flusher, pin service and routes | G-01…G-09, G-12, G-20, G-45 | AS-01…AS-11, AS-13, AS-14, AS-18, AS-19, AS-30 |
| WP-4 | Shop lifecycle consumer and status gate; sandbox via `ensureSandboxShop`; `actingShopId`/`liveShopId`; `livemode` | G-10, G-11, G-13, G-14 | AS-12, AS-17, AS-22…AS-25 |
| WP-5 | Version registry in use: pin at first key, resolution, request upgrade, response downgrade, `ApiVersionService`; request-context middleware (IDs, headers, deprecation, `410`, brownouts) | G-15…G-19 | AS-26…AS-29, AS-31…AS-36 |
| WP-6 | Scope guard, shop-scoped lookups, problem+json typed errors in guards | G-37, FR-015/016 | AS-15, AS-16, AS-65 |
| WP-7 | Products/stock/orders via R1 gateways; strict pagination, `fields`/`expand`, money objects, `If-Match`/`ETag`; additive `getShopOrder` in S10 code | G-21…G-25, G-27, G-29, S03/S05/S10 follow-ups | AS-37…AS-42 |
| WP-8 | Batch (per-operation validation, scope, tenant, idempotency, budget); bulk stock (delta, job tables, chunk worker, purge job, queue) | G-26, G-28 | AS-43…AS-47, AS-49…AS-52 |
| WP-9 | Idempotency (shared module options, required, scope), rate-limit cost and headers, auth-failure policy, quota gate and port | G-30, G-31, G-32, G-44 | AS-48, AS-53…AS-57 |
| WP-10 | Request records (buffer, sink, drops), projector (dedupe, DLQ), log service and keyset search, usage report, usage metering and closer, deprecation telemetry | G-19, G-33…G-36, G-43 | AS-35, AS-58…AS-64, AS-71 |
| WP-11 | Body limits, media types, `Accept`, `405`/`404` problems, no CORS, `no-store`; OpenAPI generation and routes (`/v1/openapi.json`, `/api/developers/openapi.json`); OWASP document + test; barrel and module split (`PublicApiProjectorModule`); wiring specs for the four apps; delete `public-api.e2e-spec.ts` after mapping every scenario (L-017) | G-38, G-40, G-41, W07 | AS-36, AS-65…AS-71 |
| WP-12 | Final checkpoint: capability suite in batches of fresh processes, static gates, leftovers greps, `check.py`, UNVERIFIED rows re-read, report (built-binary start and fresh-stack run are scripted checkpoint items, L-019) | — | all |

## Gap coverage

Every gap item is assigned: G-01 WP-2/3 · G-02…G-09 WP-3 · G-10 WP-4 · G-11 WP-4 · G-12 WP-3 · G-13, G-14 WP-4 · G-15…G-18 WP-5 · G-19 WP-5/10 · G-20 WP-3 · G-21…G-25 WP-7 · G-26 WP-8 · G-27 WP-7 · G-28 WP-8 · G-29 WP-7 · G-30…G-32 WP-9 · G-33…G-36 WP-10 · G-37 WP-1/6 · G-38 WP-11 · G-39 WP-1/11 · G-40 WP-11 · G-41 WP-11 · G-42 WP-2 · G-43 WP-5/10 · G-44 WP-9/10 (five forced-fault tests: AS-18, AS-49, AS-56, AS-57, AS-61) · G-45 WP-1…WP-11 (layering). Debt rows: D-12 (WP-7, WP-4), D-7 (tests via fixtures, WP-1), D-6 (all), D-8 (WP-11). Cross-domain table-ownership lines of `gaps.md` section 3: rows 1–7 closed by WP-4/WP-7; row 8 (tests) by WP-1; the three "Not S42" rows stay with S43/S44.

## Scenario → success criterion map

SC-001 AS-08, AS-09 · SC-002 AS-13, AS-19 · SC-003 AS-16 · SC-004 AS-22, AS-23 · SC-005 AS-26, AS-28, AS-67 · SC-006 AS-32…AS-34 · SC-007 AS-51, AS-54 · SC-008 AS-64 · SC-009 AS-58, AS-60 (retention half is an ops artifact) · SC-010 ops artifact (k6) · SC-011 AS-70 (static gates) · SC-012 AS-68.

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Hot-path regression when the guard grows (status gate, tombstone, auth-failure policy) | one `MGET` for entry + tombstone; shop status in a 60 s entry; failed-auth charge only on failure; SC-010 k6 run is an ops artifact |
| Per-shop row lock on key creation serialises a burst | creators are managers (low rate); lock held for ~4 statements; AS-05 proves the limit holds under 20 concurrent creators |
| Request-context middleware wraps `writeHead` and could double-set headers | headers set once in a single function; AS-32/AS-33 assert exact header values on success and error |
| Public contract changes are BREAKING (price object, `If-Match`, delta stock, required idempotency) | old version `2026-01-15` keeps the old shapes through upgraders; changes listed in `questions.md` BREAKING; existing scenarios are mapped, not dropped (L-017) |
| S18 `checkQuota` missing | `QuotaPort` fail-open adapter, counter, UNVERIFIED row |
| Shared idempotency change breaks other routes | additive options, the module's own e2e and the order-checkout suite re-run in WP-9 |
| ClickHouse dedupe token semantics | projector test AS-62 delivers the same record twice and asserts one row; `ReplacingMergeTree` keyed by `(shopId, requestId)` as second defence |
| Bulk queue misconfiguration (L-001, L-002) | producer validates options where the message is created; queue in `elasticmq.conf`; readiness fails while it is missing; wiring spec asserts the consumer |
| Apps that do not boot alone (L-015, L-018) | four wiring specs; module imports are explicit in each module; built-binary start at the final checkpoint |
