# Implementation Plan: S05 — Products (domain `catalog`)

**Branch**: `S05-products` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md`. Design artifacts: [research.md](research.md), [data-model.md](data-model.md), [contracts/http.md](contracts/http.md), [contracts/services.md](contracts/services.md), [contracts/events.md](contracts/events.md), [quickstart.md](quickstart.md).

## Summary

S01, S03, S49, S50, S52, S53 and S54 are built. `catalog` today can create and read a product. Its create route is open to anyone, its detail read leaks `sellerId` and exact stock, its events are `{productId}` notifications, its cache invalidation is an unconditional `DEL`, its view flush is one unbounded statement, and eight other domains read or write its table with raw SQL or its model. The plan rebuilds the product part of the domain in the S01/S03 shape without changing the table owner (the drafts and collab files are S06's and stay):

- **Pure rules in `domain/`**: status machine (`assertNever`), stock-delta rule, input normalisation and limits, cursor codec, visibility rule, error classes with stable `code`s, port interfaces and tokens (closes D-6).
- **One write path**: `ProductCommandService` (HTTP and R1), `ProductStockService`, `ProductImportService`, each as one `TransactionRunner.run` that writes the row (conditional update asserting one row, `version + 1`), the history or operation row, and **one full-state `catalog.product_*` event through `OutboxService.append`**. The entry is deleted after commit with `invalidateIfOlder`.
- **Public read** (`GET /products/:id`) through `CacheService.getOrLoad` (versioned entries, SWR, negative cache, jitter, single flight, hot-key L1, 250 ms store timeout), `VersionEtagInterceptor`, `Cache-Control`, `catalog.product-read.ip` policy; the batch route (`/batch/products`) through `getOrLoadMany` with one statement for the misses.
- **Invalidation consumer** in `ProductProjectorModule`: own consumer group, own coalescing by `productVersion`, `invalidateIfOlder`, DLQ on bad envelopes, lag histogram.
- **Views**: `WriteBehindCounter.claim/commit` with an apply that is idempotent by `batchId` (a `ProductViewBatch` marker row per chunk, same transaction as the `UPDATE`), chunks of 1,000, `fleetConcurrency: 1`.
- **Shop life**: consumers of `tenancy.shop_status_changed` and `tenancy.shop_deleted` over a version-guarded `ProductShopState` copy, resumable sweep and purge jobs, shop-id backfill through `ShopProvisioningService.ensureShopsForLegacySellers`, the `NOT NULL` contract step, no foreign key to `Shop` or `User`.
- **Boundary**: model-free public entry point (plus a short, named transitional block for the exports other domains still import), search leaves (S32), `ProductDtoService` and the raw-SQL batch controller are deleted, every cross-domain row of `gaps.md` section C is handed over in the sibling follow-ups.

Follow-ups from built specs, treated as requirements (each maps to a work package below):

| From | Requirement | Where planned |
|---|---|---|
| S01 | drop `@ForeignKey(() => User)`, `BelongsTo(User)` and the `UserModel` import in `product.model.ts`; plain id column | WP-2 (model), WP-9 (`DROP CONSTRAINT` migration), `check:table-ownership` finding 1 of 3 closes |
| S03 | call `ShopProvisioningService.ensureShopsForLegacySellers` (≤ 200) in the shop-id backfill; own the `NOT NULL` contract step on `Product.shopId`; drop the foreign key `Product.shopId → Shop` | WP-9 (job `products.backfill-shop-ids`, migrations `…-catalog-s05-contract-*`), AS-79, AS-80 |
| S49 | `declareJobType` with a payload contract next to the `JobPayloads` augmentation for every catalog job (the flush job already has one); adapt to the discriminated `JobsService.cancel` result; catch `InvalidScheduleError`, not `Error` | WP-8, WP-9 (four new job types; `upsertSchedule` wrapped; no `cancel` caller exists in catalog, verified in WP-0) |
| S49 | `fleetConcurrency: 1` where one run in the fleet is promised | WP-8 (`products.flush-view-counts`), WP-9 (`products.backfill-shop-ids`, `products.purge-shop`) |
| S52 | move the views flush from `drain`/`restore` to `claim`/`commit` with an apply idempotent by `batchId`; `getOrLoadMany` for the batch read; `invalidateIfOlder` for versioned invalidation | WP-8, WP-6, WP-7 |
| S52 (a) | the deleted `cache.e2e-spec.ts` had the only test of `GET /products/:id` (ETag `W/"<id>-v<version>"`, `304`, negative cache, view counted); S05's e2e must cover it | WP-11: `product-read.e2e-spec.ts` AS-23, AS-24, AS-25, AS-31 |
| S52 (b) | the pending hash is now `counter:{<name>}:pending` (was `wb:{<name>}`); counts staged under the old name at deploy are not read | research D-8, `quickstart.md` deploy note; accepted loss ≤ one flush interval (FR-037) |
| S52 (c) | `VersionEtagInterceptor` needs `id` (string) and `version` (non-negative integer) in the body | public view carries both (`productPublicSchema`); WP-5 |
| S53 | register `products` as `latest-per-key`; full-state `catalog.product_*` events with strictly increasing `aggregateVersion` (delete too) through `OutboxService.append`; replace the `notify` callers and `KafkaTopicGroup` use in `product.service.ts`, `drafts.service.ts` and the projectors; adopt `type`/`version`/`aggregateVersion` | WP-4 (events), WP-7 (projectors), WP-10 (`drafts.service.ts`), research D-3, D-4 |
| gaps.md | A1–A26, B (D-6, D-7, D-8, D-12, D-15, D-16, D-4), C (hand-over), D-list | Gap coverage table at the end |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; `packages/backend`, domain `catalog`; schemas in `packages/contracts`; web screens are W02/W04's (only the type and route adaptation of WP-12 is in scope).

**Primary Dependencies**: all present: `@nestjs/sequelize` + `sequelize-typescript`, `TransactionRunner` / `@Transactional` (`@app/infrastructure/context`), `OutboxService` + `defineEvent` + `TopicRegistry` (`@app/infrastructure/events`, `…/outbox`), `Projector` consumers (`@app/infrastructure/projections`), S52 `CacheService` (`getOrLoad`, `getOrLoadMany`, `invalidate`, `invalidateIfOlder`), `WriteBehindCounter`, `VersionEtagInterceptor`, `cacheKey`, `buildCacheControl`, S50 `definePolicies` / `@RateLimit`, S49 `JobHandler` / `declareJobType` / `JobsService`, `MetricsRegistry`, `CLOCK`, `AppError` / `ErrorArea`, `ApiConfigService`, from tenancy `ShopScoped`, `ShopQueryService`, `ShopProvisioningService`, event contracts `ShopStatusChanged`, `ShopDeleted`, from identity `Firewall`, `User`, `AuthenticatedUser`. Test only: `fast-check`, `test/fakes/tcp-fault-proxy.ts`, `test/utils/tenancy-fixtures.ts`. **No new runtime dependency.**

**Storage**: PostgreSQL (shared `public` schema): `Product` (altered), four new tables `ProductStatusHistory`, `ProductStockOperation`, `ProductShopState`, `ProductViewBatch`, all registered in `db/ownership.ts` as `domain:catalog` in the same change; expand/contract migrations with `lock_timeout`. Redis for entries (`product:v2:<id>`), negative entries, minimum versions, the view counter, S50 counters. Kafka topic `products.events` (compacted).

**Testing**: Jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (ten files of [test-plan.md](test-plan.md)), table-driven unit specs for the three pure modules plus `fast-check` for the stock rule. Real Postgres, Redis and event stream; fakes only at system edges (the TCP fault proxy is a real-mechanism fault injector). Playwright journeys are W04's/W02's.

**Target Platform**: Linux containers: `apps/core` hosts `ProductModule` and `ProductBatchReadModule`; `apps/worker` hosts `ProductWorkerModule` (jobs); `apps/projector` hosts `ProductProjectorModule` (invalidation and shop-event consumers).

**Project Type**: web-service (backend domain) + contracts package + minimal web type/route adaptation.

**Performance Goals**: detail read: warm = one Redis `GET` (zero in L1 for hot keys), cold = one indexed statement; batch read: one `MGET` + one statement for all misses; `getProductsByIds` exactly one statement for ≤ 500 ids; list = one statement per page (index `("shopId","createdAt" DESC,"id" DESC)`); `applyStockDelta` = one statement per item inside one transaction (≤ 100 items), no read-then-write; invalidation p99 < 5 s (test environment).

**Constraints**: no network I/O inside a transaction (shop summary lookup before it; cache delete, job enqueue and counter calls after commit); cache never the source of truth (price and stock reads for money use the database); every cache call 250 ms, database read 2 s; every key has a TTL; entry ≤ 32 KiB by field limits; no unbounded statement or transaction (flush ≤ 1,000 rows, purge ≤ 500, sweep ≤ 1,000, backfill ≤ 200 sellers); metrics carry no product, shop or user label; migrations expand/contract with `lock_timeout`, one step each.

**Scale/Scope**: 8 routes (6 new, 2 re-shaped), 4 removed; 5 R1 services (4 new classes + the existing module); 5 event types; 4 jobs + 2 internal sweep jobs; 3 consumers (cache invalidation, shop status, shop deleted); 3 rate policies; 5 new tables; 87 acceptance scenarios (ten e2e files, three unit specs, W02/W04 journeys).

### Pool arithmetic and `statement_timeout` (III.12)

- `catalog` adds no pool. It uses the shared pool of S54 (`db_pool_max` P = 10 per instance × 12 database-holding instances at the production ceiling = 120, plus read replica 30 = 150, under `max_connections` 200 with 25 reserved; see S54 plan "Pool arithmetic").
- The read path holds a connection only for the single indexed statement of a cache miss (single flight collapses concurrent misses to one per instance), so the 600 reads/min/address ceiling and the cache keep the peak well under P.
- Longest transactions: stock call ≤ 100 conditional updates plus ≤ 100 operation inserts plus ≤ 100 outbox rows (≈ 300 short statements, bounded by the 100-item cap); flush chunk ≤ 1,000 rows (one `UPDATE … FROM unnest`); purge ≤ 500 rows. None holds a connection while waiting on Redis or Kafka.
- `statement_timeout` is the pool-wide `ApiConfigService.db_statement_timeout_ms`; the public read additionally sets a 2 s deadline in the loader (research D-9).

## Constitution Check

*GATE before Phase 0; re-checked after Phase 1 (below).*

| Rule / gate | Status | How |
|---|---|---|
| I.1 / I.2 / D-6 layering | Pass (closes D-6) | `api/` → `application/` → ports and pure rules in `domain/`; adapters, models and SQL only in `infra/`; no `infra/` import in `api/` or `application/` (ports `ProductRepository`, `StockOperationRepository`, `ShopListingRepository`, `ProductEventPublisher` are not needed: events go through `OutboxService` directly, which is an infrastructure service, see D-5) |
| I.3 clock | Pass | `CLOCK` injected into application services; `domain/` takes `now` as a parameter; `check:no-wallclock` stays green; the old `Date.now()` in `product-events.ts` is deleted |
| I.4 single owner | Pass | five tables, the `product:v2:` and `counter:{product-views}:` key prefixes and topic `products.events` are owned here; registry updated |
| II.1 controllers | Pass | each method: validated DTO → one service call → response; the batch controller loses its SQL (A15); no `try/catch`, no branching on state |
| II.2 pipeline | Pass | strict DTOs (`whitelist`, `forbidNonWhitelisted`), `Firewall({anonymous:true})` only on the two public reads, `@RateLimit` metadata, `VersionEtagInterceptor` as interceptor, errors only through the global filter |
| III.1 / IX.4 data access and coupling | Pass | only `infra/` repositories touch the five tables; `Shop` and `ShopMembership` are never read (shop facts come from `ShopQueryService` and the `ProductShopState` copy); no association, no foreign key to another owner; `check:table-ownership` for `catalog` goes 3 → 0 findings (`UserModel` association, `Shop` SQL in the search projector, `ShopMembership` SQL in `drafts.service.ts`) |
| III.2 / S54 rule (4) transactions | Pass | only `TransactionRunner.run` / `@Transactional`; the single `wrapInTransaction` site in `product.service.ts` is deleted; direct `sequelize.transaction` sites in the domain stay 0 (baseline 0); no `// S54 T037 audit` comment exists in `catalog` |
| III.3 no network I/O in a transaction | Pass | shop summary read, cache delete, counter calls, job enqueue are outside the transaction; the outbox row is inside it |
| III.4 principal in the predicate | Pass | every member lookup is `WHERE id = :id AND "shopId" = :shopId`; list adds `"shopId"` first in the predicate; `getProductsByIds` takes `{shopId}`; stock ops carry `shopId` and match on it |
| III.5 SQL parameterised | Pass | replacements only; sort and status come from allowlists in `domain/` |
| III.6 invariants in the store | Pass | `quantity` check constraint plus conditional `UPDATE … SET quantity = quantity + :d WHERE … AND quantity + :d BETWEEN 0 AND 1e9`; unique `(shopId, externalSku)` (exists) and unique `operationId`; OCC by `WHERE version = :expected` |
| III.7 state transitions | Pass | `UPDATE … WHERE id AND "shopId" AND status = :from AND version = :v` asserting one row + `ProductStatusHistory` row in the same transaction; `assertNever` in the machine |
| III.8 money | Pass | `priceMinor BIGINT`, integer in JSON, explicit `currency`; no float |
| III.9 caches | Pass | cache-aside, writers delete, every entry has a TTL, no `KEYS` (the sweep walks the table by keyset, not Redis), R1 reads never use the cache |
| III.10 keyset | Pass | `ORDER BY "createdAt" DESC, "id" DESC`, opaque checksummed cursor bound to shop + filters; no offset |
| III.11 migrations | Pass | five expand migrations and two contract migrations, each with `lock_timeout`, `CONCURRENTLY` for indexes, `NOT VALID` then `VALIDATE`; run as a separate deploy step |
| III.12 timeouts / pool | Pass | arithmetic above |
| IV.1–IV.3 communication | Pass | tenancy used only through `ShopQueryService`, `ShopProvisioningService`, `ShopScoped` and its event contracts (entry point); no `forwardRef`; cross-process by events and jobs |
| IV.4 outbox | Pass | `OutboxService.append` inside the write transaction; envelope has `eventId`, `type`, `version`, `occurredAt`, `aggregateId`, `aggregateVersion` |
| IV.5 consumers | Pass | cache invalidator: version guard (`invalidateIfOlder`), shop-status: `versionGuard` (`shopVersion`), shop-deleted: natural (delete where exists) + resumable job; all zod-validated through `handles`, DLQ on poison |
| IV.6 timeouts, retries | Pass | cache 250 ms (toolkit), DB read 2 s, loader retry only in the toolkit's single layer |
| V.1–V.4 contracts, errors | Pass | explicit views parsed by `productMemberSchema`/`productPublicSchema`; problem+json with `code` for every error (list in contracts/http.md); `404` for cross-shop; `409` for conflicts; `422` for currency |
| V.5 sub-resources | Pass | `/archive`, `/restore` |
| V.6 idempotency key | N/A | products are not in the V.6 list (spec Assumptions); stock commands are idempotent by `operationId` instead |
| V.7 additive within a version | Documented breaking change | the [BREAKING] list in `questions.md` is accepted as written (removed routes, renamed money field); removal is announced in the quickstart release note; no `Deprecation`/`Sunset` period because nothing outside this repository consumes the routes (WP-12 adapts the only client) |
| VI web | Partial, by design | WP-12 changes only `lib/api/*` types and routes; screens are W02/W04 |
| VII.1 static | Pass (gate) | `tsc --noEmit`, ESLint for backend and contracts, `check:boundaries`, `check:table-ownership` with 0 findings for `catalog`. The "zero findings anywhere for `Product`" half of AS-86 / SC-009 cannot pass until the 18 sibling files convert; it is an Ops artifact (`UNVERIFIED.md`), not a claim |
| VII.2 / VII.3 API e2e | Pass | every route has the happy path, each validation class, 401, IDOR 404 matrix, 429, illegal transition 409, concurrent `Promise.all` (AS-11, AS-20, AS-53, AS-55, AS-61, AS-71) |
| VII.4 consumers | Pass | each of the three consumers has a duplicate-delivery and an invalid-payload test (AS-41, AS-44, AS-77, AS-78) |
| VII.5 unit | Pass | three pure modules only (status machine, stock rule + `fast-check`, input normalisation) |
| VII.6 contract parse | Pass | every e2e parses with the named schema; outbox payloads with `productEventSchemas` |
| VII.8 traceability | Pass | the test plan has one row per AS-01…AS-87; two e2e additions listed in WP-11 (SC-001 matrix, SC-002 1,000-request run) sit inside existing rows |
| VII.9 fallbacks | Pass | AS-22, AS-33, AS-34, AS-35, AS-67 force each degradation path; green run recorded in the final report |
| VIII.1 logs | Pass | structured, `requestId`; no request bodies; events carry no PII (titles are business data, not personal data) |
| VIII.5 config | Pass | `platform_currency`, product cache lifetimes (defaults), batch sizes validated at startup |
| VIII.6 jobs | Pass | all jobs through S49 leases, `fleetConcurrency: 1`, idempotent |
| IX.3 registry | Pass | `Product` (exists) + 4 new tables in `db/ownership.ts`; `ownership.spec.ts` stays green |
| IX.6 / IX.7 / IX.8 | Pass | R1 services exported; R2 target served by an application service; R3 snapshot events with full state; maximum staleness stated: public page ≤ 6 min worst case, normally < 5 s (spec Edge Cases); `getProductsByIds` has none (database) |
| X.2 / X.4 / X.5 | Pass with one declared transitional block | the entry point exports modules, R1 services, DTO types and event contracts; models, repositories, projectors and search classes leave. A short block of compatibility exports stays while their importers (listed in gaps.md section C) are converted; see Complexity Tracking |
| X.7 placement | Pass | the cache toolkit stays in `infrastructure/cache`; everything with the word "product" is in the domain |

**Gate result before research: no unresolved violation.** The only exception is recorded below.

## Project Structure

### Documentation (this feature)

```text
specs/domains/S05-products/
├── plan.md              # this file
├── research.md          # Phase 0: decisions D-1 … D-14
├── data-model.md        # Phase 1: tables, columns, constraints, state machine, cache keys
├── quickstart.md        # Phase 1: how to run and verify; "Ops artifacts" for unverified criteria
├── contracts/
│   ├── http.md          # routes, request/response schemas, problem codes, headers, rate policies
│   ├── services.md      # R1 service signatures, error classes, module exports
│   └── events.md        # catalog.product_* envelopes and consumed tenancy events
└── tasks.md             # NOT created here (/speckit-tasks)
```

### Source Code (repository root)

```text
packages/backend/
├── migrations/
│   ├── 2026101_____-catalog-s05-expand-columns.js          # status, createdBy, isSandbox, currency, priceMinor (+ sync trigger), indexes
│   ├── 2026101_____-catalog-s05-expand-tables.js           # ProductStatusHistory, ProductStockOperation, ProductShopState, ProductViewBatch
│   ├── 2026101_____-catalog-s05-contract-fks.js            # drop Product.sellerId → User and Product.shopId → Shop foreign keys
│   └── 2026101_____-catalog-s05-contract-shop-not-null.js  # runs only after the backfill job reports zero legacy rows (CHECK NOT VALID → VALIDATE → SET NOT NULL), quantity check validate
├── db/ownership.ts                                          # + 4 tables
├── libs/domains/catalog/
│   ├── index.ts                                             # model-free entry point + transitional block
│   ├── product.module.ts                                    # core: HTTP + R1 services
│   ├── batch-read.module.ts                                 # core: GET /batch/products
│   ├── product-worker.module.ts                             # worker: jobs
│   ├── product-projector.module.ts                          # projector: consumers          (new)
│   ├── rate-limit-policies.ts                               # catalog.product-read.ip, .product-write.shop, .batch-read.ip
│   ├── api/
│   │   ├── product.controller.ts                            # /shops/:shopId/products …  (member routes)
│   │   ├── public-product.controller.ts                     # GET /products/:productId    (new)
│   │   ├── product-batch-read.controller.ts                 # no SQL, one service call
│   │   └── product.dto.ts                                   # class-validator DTOs (strict)
│   ├── application/
│   │   ├── product-command.service.ts                       # create/update/archive/restore/listByShop/getForShop
│   │   ├── product-query.service.ts                         # getProductsByIds (database)
│   │   ├── product-stock.service.ts                         # applyStockDelta
│   │   ├── product-import.service.ts                        # upsertFromExternal
│   │   ├── public-product.service.ts                        # cache-aside detail + batch read
│   │   ├── product-cache-invalidation.service.ts            # writer-side and event-side invalidation (one place)
│   │   ├── product-views.service.ts                         # count + flush chunks (idempotent by batchId)
│   │   ├── shop-listing.service.ts                          # shop status/deleted reactions, sweep, purge
│   │   ├── product-backfill.service.ts                      # legacy shop-id backfill
│   │   ├── product.service.ts                               # DEPRECATED compat facade: findById, create (search removed); deleted with its last importer
│   │   ├── drafts.service.ts                                # publish path calls ProductCommandService.update; no Product SQL, no notify
│   │   └── events/product-events.ts                         # five defineEvent (state) + legacy ProductChanged kept (transitional)
│   ├── domain/
│   │   ├── product-status.ts (+ .spec.ts)                   # AS-21
│   │   ├── stock-rule.ts (+ .spec.ts)                       # AS-59
│   │   ├── product-input.ts (+ .spec.ts)                    # limits, tag normalisation (AS-01, AS-02)
│   │   ├── product-view.ts                                  # member / public / batch mappers (pure)
│   │   ├── visibility.ts                                    # FR-013 as a pure predicate (used by tests of the SQL predicate)
│   │   ├── product-cursor.ts                                # opaque keyset cursor bound to shop + filters
│   │   ├── product-errors.ts                                # AppError subclasses with `code`
│   │   ├── product-metrics.ts                               # AS-85 instruments
│   │   └── ports.ts                                         # ProductRepository, StockOperationRepository, ShopStateRepository, ViewBatchRepository + tokens
│   ├── infra/
│   │   ├── models/ product.model.ts, product-status-history.model.ts, product-stock-operation.model.ts, product-shop-state.model.ts, product-view-batch.model.ts
│   │   ├── product.repository.ts, stock-operation.repository.ts, shop-state.repository.ts, view-batch.repository.ts
│   │   ├── product-cache.ts                                 # key builder + loader row mapper
│   │   ├── product-cache-invalidator.projector.ts           # rewritten
│   │   ├── shop-status.consumer.ts, shop-deleted.consumer.ts
│   │   ├── product-views.jobs.ts, product-maintenance.jobs.ts   # purge-stock-operations, backfill-shop-ids, purge-shop, drop-shop-entries
│   │   └── (deleted) product-dto.service.ts, product-search.projector.ts
│   └── *.e2e-spec.ts                                        # the ten files of test-plan.md; product.e2e-spec.ts deleted
├── apps/{core,worker,projector}/src/*.module.ts             # composition only: drop search projector, add ProductProjectorModule
packages/contracts/src/catalog/index.ts                      # schemas of contracts/http.md and contracts/events.md
packages/web/lib/api/{shops,catalog}.ts                      # WP-12: new routes and field names only
```

**Structure Decision**: single backend domain following I.1, one contracts folder, no new app and no new deployable (I.6): the new `ProductProjectorModule` is hosted by the existing `apps/projector`, the jobs by `apps/worker`.

## Work packages

Order is dependency order; each ends with the narrowest test that proves it, and the whole capability suite runs once at the end of WP-11.

- **WP-0 Baseline.** Record before-numbers: `check:table-ownership` (catalog 3 findings; `Product` is used by 18 other domains' files, unchanged by this capability), direct `sequelize.transaction` sites in `libs/domains/catalog` (0; one `wrapInTransaction`), `check:boundaries`, `tsc`. Grep proves `catalog` has no `JobsService.cancel` caller and no `// S54 T037 audit` comment.
- **WP-1 Contracts.** `packages/contracts/src/catalog`: `productMemberSchema`, `productPublicSchema`, `productBatchItemSchema`, `productCreateRequestSchema`, `productUpdateRequestSchema`, `productTransitionRequestSchema`, `productPageSchema`, `productEventSchemas` (strict; limits as constants shared with the DTOs).
- **WP-2 Schema and models.** Expand migrations (columns, four tables, indexes), `db/ownership.ts`, new models, `Product` model without `User`/`BelongsTo`/`ForeignKey`, with `priceMinor`, `status`, `createdBy`, `isSandbox`, `currency`, `externalSku`, version default 1; `embedding`/`searchVector` no longer mapped. Schema e2e (AS-58, AS-80 part) proves the constraints.
- **WP-3 Domain.** Pure modules and ports with unit specs (AS-21, AS-59, tag table of AS-01). Errors and metrics.
- **WP-4 Write services.** Repositories, `ProductCommandService`, `ProductStockService`, `ProductImportService`, `ProductQueryService`, events and topic registration (`latest-per-key`), writer-side invalidation. Proves AS-01…AS-20, AS-39, AS-48…AS-65, AS-82, AS-83 from the service level first, then through HTTP in WP-5.
- **WP-5 HTTP.** Member controller, DTOs, rate policies (write 120/min/shop fail closed), removal of the old routes (AS-06, AS-87), compat facade, contract parse.
- **WP-6 Public read.** `PublicProductService` + controller + `/batch/products` rewrite; headers; visibility predicate; negative cache; view counting hook. Proves AS-23…AS-38, AS-84.
- **WP-7 Invalidation.** `ProductCacheInvalidator` rewrite, `ProductProjectorModule`, apps wiring, lag histogram, DLQ. Proves AS-40…AS-47.
- **WP-8 Views and stock-operation purge.** `claim/commit` flush with `ProductViewBatch`, chunks, `fleetConcurrency: 1`, schedule with `InvalidScheduleError` catch; purge job. Proves AS-65…AS-75.
- **WP-9 Shop life, backfill, contract.** Shop-status and shop-deleted consumers, sweep and purge jobs, backfill job, contract migrations (FKs, `NOT NULL`, check validate). Proves AS-76…AS-81.
- **WP-10 Boundary and wiring.** Barrel, modules, `apps/*`, `drafts.service.ts` rewrite (no `Product` SQL, no `ShopMembership` SQL: `ShopAccessService.assertMember` as S03 asks of S06; S06 owns the rest), delete `product-dto.service.ts` / `product-search.projector.ts` / old e2e; `check:table-ownership`, `check:boundaries`.
- **WP-11 Tests.** The ten e2e files + three unit specs; SC-001 matrix and SC-002 1,000-request test added to `W` and `Q`; fixtures for products in `test/utils`.
- **WP-12 Adjacent edits (minimal).** `packages/web/lib/api/shops.ts` and `catalog.ts` follow the new routes and fields; `assistant-tools.ts` searches through `ElasticsearchService` instead of `ProductService.search` (the only sibling source edit forced by removing search from the facade); `README` route list if it names the old routes. Everything else belongs to the sibling follow-ups in `gaps.md`.

## Gap coverage

| Gap | Package | Gap | Package |
|---|---|---|---|
| A1 update/archive/list/OCC | WP-4, WP-5 | A14 flush chunks, poison member | WP-8 |
| A2 shop-less create | WP-5 | A15 batch controller SQL | WP-6 |
| A3 route + ORM model leak | WP-5, WP-4 | A16 model/FKs/columns | WP-2, WP-9 |
| A4 DTO limits | WP-3, WP-5 | A17 search projector | WP-10 (deleted; S32 follow-up) |
| A5 public view leak, view before visibility | WP-6 | A18 stock command | WP-4 |
| A6 headers, policy | WP-6 | A19 R1 services | WP-4, WP-10 |
| A7 search in catalog | WP-10 | A20 barrel | WP-10 |
| A8 `application` → `infra` | WP-3, WP-4 | A21 shop-event consumers | WP-9 |
| A9 events | WP-4, WP-7 | A22 backfill | WP-9 |
| A10 invalidation | WP-7 | A23 drafts SQL | WP-10 |
| A11 writer delete | WP-4 | A24 metrics, codes | WP-3, WP-5 |
| A12 timeouts, `UNLINK` | toolkit (S52) provides; used in WP-6/WP-7 | A25 e2e coverage | WP-11 |
| A13 entry version, size | WP-6 | A26 one transaction shape | WP-4 |
| B D-6, D-7, D-8, D-12, D-15, D-16, D-4 | WP-3, WP-10, WP-6 | C hand-over table | `gaps.md` "Sibling-spec follow-ups" |

## Re-check after Phase 1

Design artifacts introduce no new violation. Points re-examined: (1) writer-side `invalidateIfOlder` is a cache write by the writer's process but is a delete plus a minimum, never a stored value (AS-27, AS-39 still hold); (2) the extra `ProductShopState` and `ProductViewBatch` tables are catalog-owned business and bookkeeping tables, not technical-allowlist tables (IX.3), so they sit under `domain:catalog`; (3) `ProductService` compat facade stays inside X.4 because it is exported, application-level, DTO-returning; (4) no transaction touches two owners other than the outbox (IX.6).

## Complexity Tracking

| Rule | Violation | Why it cannot be met now | Simpler alternative rejected | Removal date |
|---|---|---|---|---|
| X.4 / IX.4 (model-free entry point) | `ProductModel`, `ProductDtoModule`, `ProductDtoService`, `ProductService`, `ProductChanged`, `productChanged`, `PRODUCTS_AGGREGATE`, `ProductModule` stay exported in a block marked TRANSITIONAL | Eighteen files in thirteen other domains (gaps.md section C) import them and are owned by capabilities not yet built; deleting the exports breaks their compilation and e2e today, and spec rule 1 forbids editing their specs | Editing thirteen sibling domains inside this capability (out of scope, would collide with their own plans) | Each line is deleted by the sibling that converts its last importer; the whole block no later than the end of the last of S10, S13, S19, S24, S26, S29, S31, S32, S34, S36, S40, S41, S42, S46 (tracked in `gaps.md`); `product-boundary.e2e-spec.ts` (file B) pins the list so it can only shrink |
| IV.5 (events from one writer) | Until S07, S08, S09, S42 convert, four domains still append the legacy `catalog.product_changed` notification and update `Product` with raw SQL, bypassing `version` | Same reason; the legacy event stays defined, `carries: 'state'`, so the topic can be compacted | A hard cut that deletes the legacy writers (not ours to edit) | Same as above; consumers here treat the legacy event as an unconditional invalidation and never use its `aggregateVersion` (research D-4) |
