# Implementation Plan: S32 — Product Search (domain `discovery`)

**Branch**: `S32-product-search` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written), `.specify/memory/constitution.md` v3.1.0.

## Summary

Move the public product search out of `catalog` into `discovery` and rebuild it as a **read model** of `products.events` (IX.7 R3): an Elasticsearch index behind the alias `products`, a per-source version-guarded projection (product, shop state, image, sponsorship, popularity), 30-day delete tombstones, visibility filtering in every query, capped business boosts, cursor paging, facets that ignore their own filter, a k-NN mode with a degrading embedding provider, and signed `searchId`s for relevance measurement. Add a zero-downtime reindex **run** (state machine, dual-write, replay from the retained event history, verification gate, atomic alias switch, 24 h rollback), a versioned synonym set, and a Postgres full-text **shop search table** owned by `discovery`. Split `libs/infrastructure/elasticsearch` into a generic engine client plus a `discovery/infra` product adapter (D-16), narrow the barrel to three modules (D-8), and delete every `ProductModel` use and raw SQL on foreign tables (D-7, D-12, section C of `gaps.md`).

Technical approach: pure `domain/` logic first (guard, run states, synonym grammar, cursor, query text, popularity bucket), ports with injection tokens, adapters in `infra/`, one application service per route, S53 `Projector`s for consumption, S49 jobs for the worker, S50 policies, S54 problem+json and metrics.

## Technical Context

**Language/Version**: TypeScript 5 strict, NestJS (existing backend), Node 22.

**Primary Dependencies**: `@elastic/elasticsearch` 8.15 client (behind the generic `SearchEngineClient`), Sequelize 6 + `TransactionRunner` (S54), kafkajs through S53 `ProjectionsModule` / replay, S49 `JobsService`, S50 `@RateLimit`, `zod` (`packages/contracts`), `fast-check` for the property test, `pg_trgm` (already installed by earlier migrations).

**Storage**: Elasticsearch 8.15 (public index, synonyms set), PostgreSQL (six small tables owned by `discovery`, listed in `data-model.md`), ClickHouse (existing `search_queries`, `search_clicks`; TTL 90 d added), Kafka topics `products.events`, `shop.events`, `search.events`, plus the outbox for `search.reindex_completed`. Redis: only S50 rate-limit keys.

**Testing**: Jest e2e against the compose stack (`docker-compose.test.yaml`: Postgres, Redis, Redpanda, Elasticsearch 8.15.3, ClickHouse), `test/fakes/tcp-fault-proxy.ts`, `fast-check`; run through `scripts/sdd/test-spec.sh`. Layout per `test-plan.md` (nine e2e files, six unit files).

**Target Platform**: Linux containers: `apps/core` (HTTP), `apps/projector` (consumers), `apps/worker` (jobs).

**Project Type**: backend domain library (`packages/backend/libs/domains/discovery`) + contracts package + a web type/page port (W02).

**Performance Goals**: p95 < 300 ms at 100,000 searches/s over 50 M products (SC-001, ops artifact); freshness 10 s p95 public / 5 s p95 shop table (FR-026); engine failure answered in ≤ 1.1 s (SC-009).

**Constraints**: engine budget 1 s, embedding budget 300 ms, zero engine queries on invalid input, exactly one engine query per search (FR-013), no query text outside the redacted event (FR-059), no network I/O in a DB transaction (III.3).

**Scale/Scope**: 50 M products, 5,000 product changes/s (SC-002), ≤ 5,000 synonym rules, 4 jobs of bulk work.

No `NEEDS CLARIFICATION` remains; decisions are in [research.md](research.md) (R-01 … R-16).

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 design — see the second table.*

| # | Gate | Status | Evidence in this plan |
|---|---|---|---|
| 1 | Boundaries (I.1–I.5, no `forwardRef`, no `Scope.REQUEST`) | PASS | Layout below; ports in `domain/ports.ts` with tokens; adapters in `infra/`; apps import only `ProductSearchModule`, `SearchProjectorModule`, `SearchWorkerModule`; `domain/` files import no Nest, Sequelize, kafkajs, ES client and take `now` as a parameter |
| 2 | Controllers (II.1) | PASS | `search.controller`, `shop-product-search.controller`, `search-click.controller`, `search-admin.controller`: DTO in, one application call, DTO out; errors raised as typed exceptions mapped by the S54 filter; no try/catch building responses |
| 3 | Data access (III.1–III.12) | PASS | Principal (`shopId`) in the shop-search predicate; keyset cursors everywhere; bind parameters, hard-coded sort allowlist; run transitions are conditional updates with history; single active run by partial unique index; synonym edit by conditional claim; no engine call inside a transaction (R-06, R-07); money is `bigint`/minor units; `TransactionRunner.run` only; pool arithmetic in R-13 |
| 4 | Migrations (III.11) | PASS | Expand-only migrations with `lock_timeout`; ownership registry entries in the same change; the catalog's `embedding`/`searchVector` columns are S05's contract step after S32 is live |
| 5 | Messaging (IV.4–IV.6) | PASS | Consumers use S53 `Projector` with zod validation, `idempotency: 'versionGuard'` documented per group, DLQ, jittered backoff; `search.reindex_completed` through the outbox inside the run's transaction; `search.performed` / `search.result_clicked` are not DB-originated (direct producer, drop counter); every outbound call (engine, embedding provider, ClickHouse, tenancy/media R1) has an explicit timeout; retries at one layer (the projection framework) |
| 6 | Contracts (V.1–V.3) | PASS | Explicit DTOs, no index document or vector serialised; schemas in `packages/contracts/src/search/`; problem+json codes listed in `contracts/http-api.md`; `Idempotency-Key` does not apply (no order/payment/ledger POST) |
| 7 | Web (VI) | PASS | W02 port only: types from `packages/contracts`, calls stay in `lib/api/catalog.ts`, URL state carries `q`, filters, `sort`, `cursor`; no new client store |
| 8 | Tests (VII) | PASS | Nine e2e files + six unit files per `test-plan.md`; each consumer has duplicate + invalid payload tests; every degradation path (engine down, embedding timeout, stream down, limiter down) has a forcing test; green run recorded at the end (VII.9) |
| 9 | Operational (VIII) | PASS | Metrics list of FR-059 on the S54 registry; logs carry `requestId`/`runId`, no raw query; config validated at startup (`search_log_secret`, `search_id_signing_key`, budgets); jobs single-run via S49 and idempotent |
| 10 | DB isolation (IX) | PASS | Six new objects registered in `db/ownership.ts` and `docs/architecture/domain-map.md` in the same change; no `ProductModel`/`ShopModel` injection, no raw SQL on foreign tables; foreign data only via R3 events, `ShopQueryService.getShopsByIds` and `MediaQueryService.getReadyMediaByIds` (R1); `check:table-ownership --strict` must report zero for discovery search code |
| 11 | Monorepo (X) | PASS | Generic engine client stays in `libs/infrastructure/elasticsearch`; product knowledge moves to `discovery/infra`; barrel exports modules, services and event contracts only; no new top-level folder; no new app (all work fits `core`, `projector`, `worker`) |

After Phase 1 design: all eleven gates still PASS. Items that look like violations and are not: the shop-state `update_by_query` and the product write are two idempotent steps against two different stores (not one transaction across owners); the reindex `CATCHING_UP → COMPLETED` transaction writes only discovery tables plus the allowlisted outbox (IX.6).

## Project Structure

### Documentation (this feature)

```text
specs/domains/S32-product-search/
├── plan.md              # this file
├── research.md          # Phase 0 decisions R-01 … R-16
├── data-model.md        # Phase 1: tables, index document, run/synonym state, events
├── quickstart.md        # Phase 1: how to prove it, plus Ops artifacts
├── contracts/
│   ├── http-api.md      # routes, parameters, problem codes, policies
│   └── events-and-ports.md  # events, exported services, jobs, config keys
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
packages/contracts/src/search/
├── index.ts                 # re-exported from packages/contracts/index.ts
├── product-search.ts        # productSearchQuerySchema, productSearchResponseSchema
├── shop-product-search.ts   # shopProductSearchQuerySchema, shopProductSearchResponseSchema
├── admin.ts                 # reindexRunSchema, searchIndexStatusSchema, synonymsPutRequestSchema, synonymsSchema, searchQualityReportSchema
├── click.ts                 # searchClickRequestSchema
└── events.ts                # searchEventSchemas

packages/backend/libs/infrastructure/elasticsearch/       # generic only (D-16)
├── search-engine.client.ts  # search, mget, bulk, count, index/alias ops, update/delete-by-query, synonyms API, timeouts
├── search-engine.errors.ts
└── elasticsearch.module.ts  # exports SearchEngineClient
# EsVersionedSink (libs/infrastructure/projections/sinks) and fulfilment's projector/availability index switch to SearchEngineClient

packages/backend/libs/domains/discovery/
├── index.ts                 # ProductSearchModule, SearchProjectorModule, SearchWorkerModule, ProductSearchService,
│                            # ProductTitleSuggester, DTO types, event contracts; existing S33–S35 exports unchanged
├── product-search.module.ts     # core: HTTP controllers + exported services (replaces search-admin.module.ts)
├── search-projector.module.ts   # projector: product, shop-state, media, sponsorship, clicks, queries
├── search-worker.module.ts      # worker: jobs (replaces search-reindex-worker.module.ts)
├── rate-limit-policies.ts       # the four discovery.* policies
├── api/
│   ├── search.controller.ts            # GET /products/search
│   ├── shop-product-search.controller.ts
│   ├── search-click.controller.ts      # POST /search/clicks
│   ├── search-admin.controller.ts      # index, reindex, rollback, cancel, synonyms, quality
│   └── dto/                            # request DTOs built from the contracts schemas
├── application/
│   ├── product-search.service.ts       # exported R1 service, shared by the controller
│   ├── title-suggester.service.ts      # ProductTitleSuggester
│   ├── shop-product-search.service.ts  # rewritten on ShopSearchRepository
│   ├── search-click.service.ts
│   ├── search-quality.service.ts
│   ├── reindex/{start,cancel,rollback,get-runs}.service.ts, run-executor.service.ts, verify-reindex.ts
│   ├── synonyms.service.ts
│   ├── search-index-status.service.ts
│   ├── projection/{product,shop-state,gallery,sponsorship}.handler.ts
│   ├── jobs/{refresh-popularity,backfill-shop-state,backfill-embeddings,purge-tombstones,retire-previous-index}.job.ts
│   └── events/search-query-events.ts   # existing, extended with the run event
├── domain/
│   ├── ports.ts + tokens        # ProductIndexPort, ShopSearchRepository, ReindexRunRepository, SynonymSetRepository,
│   │                            # ShopStateRepository, EmbeddingProvider, ProductImageResolver, SearchEventPublisher, Clock
│   ├── projection-guard.ts (+ .spec.ts)      # AS-81
│   ├── reindex-run-status.ts (+ .spec.ts)    # AS-82
│   ├── synonym-rules.ts (+ .spec.ts)         # AS-83
│   ├── search-cursor.ts (+ .spec.ts)         # AS-84
│   ├── query-text.ts (+ .spec.ts)            # AS-85
│   ├── popularity-bucket.ts (+ .spec.ts)     # AS-86 (+ fast-check)
│   ├── visibility-filter.ts, boost.ts, index-definition.ts, consumed-events.ts, search-errors.ts, search-id.ts
├── infra/
│   ├── product-index.adapter.ts        # ProductIndexPort over SearchEngineClient (moved product mapping/queries)
│   ├── models/{search-shop-product,search-shop-state,search-reindex-run,search-reindex-run-history,search-synonym-set,search-synonym-version}.model.ts
│   ├── repositories/*.repository.ts
│   ├── projectors/{product-index,shop-state,media,sponsorship}.projector.ts  # S53 Projector classes
│   ├── search-clicks.projector.ts, search-queries.projector.ts   # kept, no longer exported
│   ├── search-query-logger.ts → search-event.publisher.ts        # not exported; dedicated secret, redaction
│   ├── embedding/hash-embedding.provider.ts
│   ├── image/{media-image.resolver,null-image.resolver}.ts
│   └── search.jobs.ts                 # declareJobType for the six job names
└── *.e2e-spec.ts            # search-query, search-facets-semantic, search-projection, search-reindex, search-synonyms,
                             # shop-product-search, search-measurement, search-admin, search-platform

packages/backend/migrations/    # expand-only, lock_timeout: six tables, synonym seed v1, indexes; db/clickhouse TTL migration
packages/backend/db/ownership.ts, docs/architecture/domain-map.md   # registry entries
packages/web/{lib/api/catalog.ts, app/search/page.tsx, tests/search.spec.ts}   # W02 port (contracts types, cursor, searchId on click)
```

**Structure Decision**: all work stays inside the existing `discovery` domain and the existing apps; the only infrastructure change is the generic client. No new deployable app (I.6).

## Phase order (feeds `/speckit-tasks`)

Matches section D of `gaps.md`; each phase is shippable and tested before the next.

1. **Ownership and schema** — registry rows, `domain-map.md`, six expand migrations with `lock_timeout`, synonym seed v1, ClickHouse TTL. Run `check:table-ownership` and **replace section C of `gaps.md` with its exact output** (it was never run when the spec was written); any extra line is a new gap.
2. **Contracts** — `packages/contracts/src/search/*`, parity fixtures for the events.
3. **Engine split and ports** — `SearchEngineClient`, rewire `EsVersionedSink` and `fulfilment`, `ProductIndexPort` adapter, injection tokens.
4. **Pure domain, test-first** — the six unit files (AS-81 … AS-86); the guard also gets a permutation property test (SC-004).
5. **Projection** — four projectors, shop-state copy, tombstones, DLQ, coalescing, shop-search table; `search-projection.e2e-spec.ts` (AS-22 … AS-38).
6. **Search service and routes** — query builder, visibility, boosts, filters, sorts, cursor, facets, semantic mode, `searchId`, logging, policies, problem codes, exported `ProductSearchService` / `ProductTitleSuggester`; `search-query` and `search-facets-semantic` e2e. Remove the catalog route/service use of `ElasticsearchService.searchProducts` together with S05's side (sibling follow-up if S05 still holds it).
7. **Reindex** — runs, state machine, job, dual-write registry, replay, verification, switch, rollback, retirement, bootstrap, legacy migration; `search-reindex.e2e-spec.ts` rewritten (AS-39 … AS-51).
8. **Synonyms** — store, routes, engine set; `search-synonyms.e2e-spec.ts`.
9. **Shop search** — routes on the new table; delete the raw SQL service body; `shop-product-search.e2e-spec.ts`.
10. **Measurement and jobs** — click endpoint, consumers, report validation, popularity / backfill / purge jobs; `search-measurement.e2e-spec.ts`.
11. **Wire-up and gates** — apps import the three modules, barrel narrowed (D-8), `search-admin.e2e-spec.ts`, `search-platform.e2e-spec.ts`, W02 port, `check:table-ownership --strict`, `check:boundaries`, `tsc`, whole discovery suite once, record the green run, fill `specs/UNVERIFIED.md` rows.

## Follow-ups from built specs (requirements; each has a task and a test)

| From | Requirement | Where planned / proven |
|---|---|---|
| S03 | No `ShopModel` / `ShopMembershipModel` / `MembershipService` / raw tenancy SQL in discovery search code; use `ShopScoped`, `ShopQueryService`, `MembershipQueryService` where needed. The `payouts.read` / `sso.manage` changes do not touch discovery routes; the shop search route is `ShopScoped('products.read')`, so its closed-shop answers are retested: `403 shop_suspended`, `409 shop_offboarding`, `404 DELETED` (as spec AS-64 states) | Phase 9; AS-64 in `shop-product-search.e2e-spec.ts`; grep gate in AS-80 |
| S05 | Host both search routes; take over the projector; query logger; popularity from clicks; `search.query` declaration still carried by catalog; `RESERVED_PRODUCT_SEGMENTS`; `embedding` transitional; move old search cases | Phases 5, 6, 10, 11; `search-query.e2e-spec.ts` replaces `product.e2e-spec.ts:66-150` cases (those cases are deleted from the catalog spec by S05 per its contract; if still present they are removed here with only those lines touched) |
| S49 | `declareJobType` with payload contracts for `search.reindex`, `search.retire-previous-index`, `search.refresh-popularity`, `search.backfill-shop-state`, `search.backfill-embeddings`, `search.purge-tombstones`; handle the discriminated `JobsService.cancel` result; catch `InvalidScheduleError` | Phases 7, 10; jobs e2e in `search-reindex` / `search-projection` |
| S50 | Own policies replace mis-used ones (G-35); names stay declared where call sites remain | `rate-limit-policies.ts`; AS-12, AS-52, AS-69, AS-71 |
| S53 | Take over `ProductSearchProjector` (group `search-indexer` kept), no `"Shop"` SQL (G-55: R3 copy), generic ES client under `EsVersionedSink` (D-16) | Phases 3, 5; `versioned-sinks.e2e-spec.ts` must stay green |

## Complexity Tracking

| Rule | Why it cannot be met | Simpler alternative rejected | Removal date |
|---|---|---|---|
| IX.4 (transitional) | `catalog` keeps `Product.embedding`/`searchVector` columns until S32 is live | Dropping them now would break rollback of S32 | Contract step by S05 after S32 acceptance; target 2026-11-30 |
| — | Verification gate compares to the live index count rather than a recomputed distinct-key set (research R-07) | Scratch table of 50 M keys | Revisit only if the human rejects R-07 |

No other exceptions.

## Open sibling dependencies (not blockers)

`media.gallery_changed` + `MediaQueryService.getReadyMediaByIds` (S29), `marketing.product_sponsorship_changed` (S36) and `shopVersion` on three tenancy events (S03) do not exist yet. The plan consumes locally defined schemas and a null image resolver until they do; each is a bullet under "Sibling-spec follow-ups" in `gaps.md`.
