# Tasks: S05 — Products (domain `catalog`)

**Input**: `specs/domains/S05-products/` — plan.md, spec.md, test-plan.md, gaps.md, questions.md (defaults accepted), research.md, data-model.md, contracts/{http,services,events}.md, quickstart.md. Constitution: `.specify/memory/constitution.md`.

**Tests**: required (test-plan.md). Order is test-first: in every story phase the failing test task for a test-plan row comes before the code task that makes it pass. A test task is "done" when it is written, runs, and fails for the right reason (or, for a pure-unit or static row, is written against the stub).

**Paths**: `packages/backend/…` unless stated. `D` = `packages/backend/libs/domains/catalog`. `S=/opt/sdd/repo/scripts/sdd/test-spec.sh`. Run backend commands from `packages/backend`. Run e2e only via `$S <path-or-pattern>`; open the full log only if the condensed output is not enough. Narrowest test per task; whole suite `$S libs/domains/catalog` once in the last phase. If the same test still fails after 5 fix attempts: stop and write blocker, what was tried and hypothesis into `questions.md`.

**Rules that apply to every task**
- Transactions only through `TransactionRunner.run` / `@Transactional`; never add `sequelize.transaction` (baseline in `D` = 0; `wrapInTransaction` site is deleted).
- Never use git checkout/restore/reset/stash/clean; undo by hand-editing only the named lines.
- Do not edit another capability's spec. Cross-domain needs go under `## Sibling-spec follow-ups` in `gaps.md` (that section already exists; T112 reconciles it).
- Every SC-nnn not proven by a test goes to quickstart.md "Ops artifacts" and `specs/UNVERIFIED.md` (status `not run`); never call it verified.
- Every new table is registered in `db/ownership.ts` in the same change as its migration.

## Format: `[ID] [P?] [Story] Description` — `[P]` = different files, no dependency on an incomplete task.

---

## Phase 1: Setup (WP-0, WP-1)

- [X] T001 Record baselines in a scratch note appended to `specs/domains/S05-products/research.md` ("Baseline 2026-10-10"): run `pnpm check:table-ownership` (expect `catalog` 3 findings: `UserModel` association in `product.model.ts`, `Shop` SQL in `product-search.projector.ts`, `ShopMembership` SQL in `drafts.service.ts`), `pnpm check:boundaries`, `npx tsc --noEmit -p tsconfig.json`, and `grep -rn "sequelize.transaction\|S54 T037 audit" libs/domains/catalog` (expect 0 sites; 1 `wrapInTransaction` in `application/product.service.ts`). Also grep `libs/domains/catalog` for `JobsService.cancel` / `.cancel(` callers (expect none; S49 follow-up) and record that.
- [X] T002 [P] Create `packages/contracts/src/catalog/index.ts` limit constants shared with DTOs (title 1–200 code points, description 0–4,000, brand/category 1–100, `priceMinor` 1…10,000,000,000, quantity 0…1,000,000,000, tags ≤ 32 of 1–50 code points trimmed/lower-cased/de-duplicated in order, `externalSku` 1–128, stock delta ±1,000,000, ≤ 100 stock ops, ≤ 500 import items, ≤ 500 ids, batch route ≤ 100 ids).
- [X] T003 [P] In `packages/contracts/src/catalog/index.ts` add strict zod schemas from `contracts/http.md` and `contracts/events.md`: `productMemberSchema`, `productPublicSchema` (carries `id` string and `version` non-negative integer for `VersionEtagInterceptor`; no `sellerId`, no `quantity`), `productBatchItemSchema` (`{id, shopId, title, priceMinor, currency, inStock, category, rating}`), `productCreateRequestSchema`, `productUpdateRequestSchema`, `productTransitionRequestSchema` (`expectedVersion` required), `productPageSchema`, `productEventSchemas` (five types; snapshot payload `{productId, shopId, title, description, brand, category, priceMinor, currency, rating, tags, quantity, inStock, status, isSandbox, externalSku: string|null, productVersion, createdAt, updatedAt, changedFields}`; deleted = `{productId, shopId, productVersion}`; no view counts, `createdBy`, embeddings). Export from the contracts barrel; `cd ../contracts && npx tsc --noEmit`.
- [X] T004 [P] Add test fixtures in `packages/backend/test/utils/` (extend the existing tenancy fixtures): `createProduct(shop, overrides)` that goes through SQL/repository without events, `createProducts(shop, n)` bulk, helper to read outbox rows by `aggregateId`, helper to count statements via a Sequelize logging hook on the real connection, clock helper usage for catalog specs. Reuse `test/fakes/tcp-fault-proxy.ts` (do not rewrite).
- [X] T005 [P] Confirm config: add `platform_currency` (ISO 4217, default `USD`, validated at startup) and catalog cache/batch settings (defaults) to `ApiConfigService`; unit-check startup validation fails on a bad currency (add to the nearest existing config spec).

---

## Phase 2: Foundational (WP-2, WP-3) — blocks all stories

**Gaps closed**: A8 / D-6 (ports), A16 (model, FKs, columns), A24 (error codes, metrics), S01 follow-up (drop `@ForeignKey(() => User)`), S49 follow-up (`declareJobType`).

### Tests first

- [X] T006 [P] Write failing unit spec `D/domain/product-status.spec.ts`: `it.each` over every (status, transition) pair of `ACTIVE ⇄ ARCHIVED` (AS-21), only `archive` from `ACTIVE` and `restore` from `ARCHIVED` legal, everything else `invalid_transition`; exhaustive switch proven with `assertNever`.
- [X] T007 [P] Write failing unit spec `D/domain/stock-rule.spec.ts` (AS-59): `it.each` edges (0, 1e9, ±1e6, zero delta refused) plus `fast-check` property that prefix sums of any accepted delta sequence stay in `[0, 1e9]` and rejected deltas never change quantity.
- [X] T008 [P] Write failing unit spec `D/domain/product-input.spec.ts` (AS-01 tag table, AS-02 limits): tags trimmed, lower-cased, de-duplicated in order, 1–50 code points, ≤ 32; title/description/brand/category code-point limits counted in code points not UTF-16 units; `priceMinor` `1…10,000,000,000` (0 refused); unknown fields refused.
- [X] T009 [P] Write failing schema e2e part of `D/product-shop-lifecycle.e2e-spec.ts` (AS-58, AS-80 part): fixture writes `quantity = -1` and a duplicate `(shopId, externalSku)` both refused by the database; catalog of foreign keys on `public` shows no FK from `Product` to `User` or `Shop`; new tables exist; `D/ownership` registry (`db/ownership.ts` test `ownership.spec.ts`) lists all five tables as `domain:catalog`.

### Implementation

- [X] T010 Migration `packages/backend/migrations/2026101_____-catalog-s05-expand-columns.js`: with `lock_timeout`, add `Product.status varchar(16) NOT NULL DEFAULT 'ACTIVE'` + `CHECK (status IN ('ACTIVE','ARCHIVED'))`, `createdBy UUID NULL` (copy from `sellerId` for legacy rows), `isSandbox BOOLEAN NOT NULL DEFAULT false`, `currency varchar(3) NOT NULL` (backfilled with platform currency), `priceMinor BIGINT NOT NULL` (copy of `price`) with a trigger mirroring `price` ⇄ `priceMinor`, `version` default 1 and legacy `0` raised to 1 with `CHECK (version >= 1) NOT VALID`, `CHECK ("quantity" >= 0 AND "quantity" <= 1000000000) NOT VALID`, index `("shopId","createdAt" DESC,"id" DESC)` `CONCURRENTLY`; `uuidv7()` id default if absent. One step per statement group; down migration provided.
- [X] T011 Migration `…-catalog-s05-expand-tables.js`: create `ProductStatusHistory` (id uuidv7 PK, productId, shopId, fromStatus/toStatus varchar(16) with `CHECK` for the two legal pairs, productVersion, actorId NULL, `at` timestamptz; indexes `("productId","at")`, `("shopId")`), `ProductStockOperation` (`operationId` varchar(128) PK, productId, shopId, `delta` non-zero `CHECK (delta <> 0 AND abs(delta) <= 1000000)`, `reason` varchar(64) `CHECK` `[a-z0-9._-]{1,64}`, quantityAfter, productVersion, appliedAt; indexes `("appliedAt")`, `("shopId")`), `ProductShopState` (shopId PK, status varchar(16) `ACTIVE|SUSPENDED|DELETING|DELETED`, shopVersion INTEGER, updatedAt), `ProductViewBatch` (PK `(batchId, chunk)`, appliedAt). No foreign keys anywhere.
- [X] T012 Update `packages/backend/db/ownership.ts`: register `ProductStatusHistory`, `ProductStockOperation`, `ProductShopState`, `ProductViewBatch` as `domain:catalog`; keep `ownership.spec.ts` green.
- [X] T013 [P] Rewrite `D/infra/models/product.model.ts`: remove `@ForeignKey(() => User)`, `BelongsTo(User)` and the `UserModel` import (plain `sellerId` / `createdBy` id columns; `sellerId` unmapped from serialisation); map `priceMinor`, `status`, `createdBy`, `isSandbox`, `currency`, `externalSku`, `version` default 1; stop mapping `embedding` and `searchVector`; remove the `shopId` foreign key decoration (plain UUID). Keep export name `ProductModel` (transitional).
- [X] T014 [P] Create models `D/infra/models/product-status-history.model.ts`, `product-stock-operation.model.ts`, `product-shop-state.model.ts`, `product-view-batch.model.ts` (no associations) and register them in the catalog Sequelize `forFeature` list.
- [X] T015 [P] Create pure modules to make T006/T007/T008 pass: `D/domain/product-status.ts` (machine with `assertNever`), `D/domain/stock-rule.ts`, `D/domain/product-input.ts` (limits from contracts constants, normalisation), `D/domain/product-view.ts` (member / public / batch mappers; public view omits `sellerId` and `quantity`), `D/domain/visibility.ts` (public iff `status='ACTIVE' AND NOT isSandbox AND COALESCE(shopState.status,'ACTIVE')='ACTIVE'`), `D/domain/product-cursor.ts` (opaque checksummed keyset cursor bound to shop + filters, `createdAt DESC, id DESC`). Run `npx jest libs/domains/catalog/domain`.
- [X] T016 [P] Create `D/domain/product-errors.ts`: `AppError` subclasses with stable `code` — `ProductNotFoundError`, `VersionConflictError{currentVersion}`, `InvalidTransitionError`, `ProductArchivedError` (`product_archived`), `ShopNotActiveError`, `StockOperationConflictError`, `CurrencyNotSupportedError` (422); codes listed in `contracts/http.md`.
- [X] T017 [P] Create `D/domain/product-metrics.ts` (AS-85): `catalog_product_read_total{outcome}`, `catalog_product_invalidation_total{result}`, `catalog_product_invalidation_lag_seconds`, `catalog_view_flush_total{result}`, `catalog_view_flush_pending`, `catalog_stock_operation_total{result}`, `catalog_backfill_orphans`, `catalog_shop_sweep_total{kind}`; no product, shop or user labels.
- [X] T018 Create `D/domain/ports.ts`: `ProductRepository`, `StockOperationRepository`, `ShopStateRepository`, `ViewBatchRepository` interfaces + injection tokens (closes D-6). Application code imports only these.
- [X] T019 Run T009 and `npx jest libs/domains/catalog/domain`; with the migrations applied by the harness the schema test must pass.

**Checkpoint**: contracts, schema, models, pure domain and ports exist; `tsc` green.

---

## Phase 3: User Story 1 — A seller lists a product and keeps it current (P1) 🎯 MVP

**Goal**: member-only write API (create, update, archive, restore, list, get) with OCC, status machine, history, one full-state event per change.
**Independent test**: `$S libs/domains/catalog/product-write` (AS-01…AS-22, SC-001 matrix).
**Gaps**: A1, A2, A3, A4, A9, A11, A24, A26; S53 follow-up (events through `OutboxService.append`, `latest-per-key`, `aggregateVersion`); S54 rule (transactions).

### Tests (write first, all in `D/product-write.e2e-spec.ts`, top-level `describe('Product write API')`, parse responses with the contracts schemas and outbox payloads with `productEventSchemas`)

- [X] T020 [US1] AS-01 create (STAFF member: `201`, row, `version: 1`, outbox `catalog.product_created` with `aggregateVersion: 1`, member view parses, no `embedding`/`searchVector`/`sellerId`) and AS-03 currency (default platform currency; other currency `422` `CurrencyNotSupportedError`).
- [X] T021 [US1] AS-02 create validation: table-driven over every class (missing field, over-length, `priceMinor` 0/over max/float, quantity over max, tag rules, seller-supplied `rating`, unknown field), nothing persisted. AS-08 update validation: table-driven (missing/non-integer `expectedVersion`, same field classes).
- [X] T022 [US1] AS-04 who may write (no credentials `401`; `VIEWER` `403`; non-member and unknown shop identical `404`), AS-05 shop status gate (`SUSPENDED` `403`, `DELETING` `409 shop_offboarding`), AS-06 removed routes (`POST /products`, `POST /products/shops/:shopId` `404`).
- [X] T023 [US1] AS-07 update (`200`, version +1, `changedFields`, outbox event, cache entry already deleted), AS-09 no-op update (no write, no event; stale version beats no-op), AS-10 stale version (`PATCH`, `archive`, `restore` each `409 version_conflict` with `currentVersion`).
- [X] T024 [US1] AS-11 concurrent edits (`Promise.all` of two `PATCH`; one `200`, one `409`, one event) and AS-20 archive races edit (one winner, consistent final row, history and event counts).
- [X] T025 [US1] AS-12 cross-shop access: matrix of `GET`/`PATCH`/`archive`/`restore` × two shop paths, byte-identical `404` bodies; AS-13 read one as member (all roles incl. `VIEWER`, archived visible, `404`, `400` for malformed id).
- [X] T026 [US1] AS-14 list paging (45 products, equal `createdAt` tie-break, insert between pages, bad limits/cursors `400`) and AS-15 list filters (`status`, `category`, `inStock`, combined, unknown values).
- [X] T027 [US1] AS-16 archive (status, history row, event, public `404`, batch `null`), AS-17 restore (status, history, event, public `200`), AS-18 illegal transitions (`409`), AS-19 edit while archived (`409 product_archived`, OK after restore).
- [X] T028 [US1] AS-22 write rate limit (121st write `429` + `Retry-After`, reads unaffected; limiter store down via fault proxy → `503`, fail closed). Also add the SC-001 matrix test (every write route × every role/state class) inside this file.
- [X] T029 [US1] Write `D/product-events.e2e-spec.ts` parts AS-82 (every outbox payload parses with `productEventSchemas`; `aggregateVersion` rises by exactly 1 per product; no-op writes none), AS-83 (a Postgres trigger makes the outbox insert fail → full rollback, no entry deleted, no history row), AS-85 (log fields `requestId`, metrics move, problem+json members).

### Implementation

- [X] T030 [US1] Create `D/infra/product.repository.ts` (implements `ProductRepository`): conditional `UPDATE … WHERE id AND "shopId" AND version = :expected` asserting one row, `version + 1`, `updatedAt` from injected clock; transition update `WHERE status = :from AND version = :v`; keyset list with `"shopId"` first in the predicate and sort/status from allowlists; parameterised replacements only; 2 s read deadline.
- [X] T031 [US1] Register `products` as `latest-per-key` and create `D/application/events/product-events.ts`: five `defineEvent` with `carries: 'state'` (`catalog.product_created|updated|archived|restored|deleted`, envelope `type`, `version: 1`, `aggregateVersion = productVersion`, `aggregateId = productId`) bound to `PRODUCTS_AGGREGATE` (`retention: 'latest-per-key'`); keep legacy `ProductChanged`/`productChanged` defined (transitional, `carries: 'state'`); delete `Date.now()` use.
- [X] T032 [US1] Create `D/application/product-cache-invalidation.service.ts`: writer-side `invalidateIfOlder(key, version)` after commit (bounded concurrency 20, failures logged and counted, never thrown) and event-side entry; key builder in `D/infra/product-cache.ts` (`product:v2:<id>`).
- [X] T033 [US1] Create `D/application/product-command.service.ts`: `create`, `update`, `archive`, `restore`, `listByShop`, `getForShop`; each write is one `TransactionRunner.run` containing the conditional row write, the `ProductStatusHistory` row (transitions) and one `OutboxService.append` of the full-state event; shop summary (`ShopQueryService`: status, `isSandbox`) read before the transaction; no-op update writes nothing; `ARCHIVED` refuses edits; then writer-side invalidation after commit. Depends on T030–T032.
- [X] T034 [US1] Create `D/api/product.dto.ts` (strict class-validator DTOs, `whitelist`, `forbidNonWhitelisted`, limits from contracts) and rewrite `D/api/product.controller.ts` to `POST/GET /shops/:shopId/products`, `GET/PATCH /shops/:shopId/products/:productId`, `POST …/archive`, `POST …/restore` with `ShopScoped('products.write'|'products.read')`; each method: validated DTO → one service call → response mapped through `domain/product-view.ts`; remove shop-less `POST /products`, `POST /products/shops/:shopId`, the `SearchQueryLogger` and every `@app/domains/discovery` import, and the search routes (D-15). Add `D/rate-limit-policies.ts` policy `catalog.product-write.shop` (120/min/shop, fail closed) with `@RateLimit`.
- [X] T035 [US1] Reduce `D/application/product.service.ts` to the compat facade (`findById`, `create`) delegating to the new services; delete the `wrapInTransaction` site and the `ElasticsearchService` injection and `search`; delete `notify` callers (S53). Mark `DEPRECATED` with owner removal note.
- [X] T036 [US1] Wire `D/product.module.ts` providers, tokens and repositories; run `$S libs/domains/catalog/product-write` and `$S libs/domains/catalog/product-events` (AS-82/83/85 for the write events); fix until green.

**Checkpoint**: US1 independently shippable; MVP.

---

## Phase 4: User Story 2 — A shopper opens a product page and it is fast and correct (P1)

**Goal**: cache-aside public detail + R2 batch read with ETag, SWR, negative cache, fallbacks.
**Independent test**: `$S libs/domains/catalog/product-read` and `…/product-cache`.
**Gaps**: A5, A6, A12 (toolkit used), A13, A15; S52 follow-ups (a) replacement e2e for the deleted `cache.e2e-spec.ts` (ETag `W/"<id>-v<version>"`, `304` on `If-None-Match`, unknown id negatively cached, view counted), (c) `id` + `version` in the body; `getOrLoadMany`.

### Tests first

- [X] T037 [US2] `D/product-read.e2e-spec.ts` (`describe('Public product read API')`): AS-23 detail (public body parses with `productPublicSchema`, `ETag: W/"<id>-v<version>"`, `Cache-Control: public, s-maxage=15, stale-while-revalidate=30`, one entry cached, view counted), AS-24 conditional request (`304` on `If-None-Match`, new ETag after update; `304` counts a view), AS-25 hidden products (archived, sandbox, suspended/deleting/deleted shop, unknown → identical `404`, `s-maxage=5`, no view counted), AS-26 malformed id (`400`, zero statements, zero cache access).
- [X] T038 [US2] In the same file: AS-31 negative caching (404 twice = 1 statement; again after +13 s), AS-32 read rate limit (700 random ids from one address: 600 × `404` then `429`), AS-33 limiter store down (reads served fail open, failure counted), AS-38 batch read R2 (order kept, `null` for invisible, duplicates, 100 cold ids = 1 statement for the misses, `400`s for >100 and malformed, headers, `429`), plus SC-006 check.
- [X] T039 [US2] `D/product-cache.e2e-spec.ts` (`describe('Product cache behaviour')`): AS-27 cache-aside (miss 1 statement, hit 0, write deletes), AS-28 avalanche (200 entries, each with TTL, within ±10%, ≥ 10 distinct), AS-29 stampede (100 concurrent on one instance = 1 statement; two instances ≤ 2), AS-30 SWR (clock +61 s: 100 concurrent served at once, one refresh; +361 s miss).
- [X] T040 [US2] Same file: AS-34 cache down (refuse and hang modes via fault proxy: `200` within 2 s, no view counted, repopulates; `PATCH` `200` with cache down), AS-35 database down with warm cache (warm `200`, cold `503` generic problem+json), AS-36 hot key (two instances, 200 reads, L1 hits, Redis `GET` count flat, update visible on both within 1 s), AS-37 big keys (max-size product, entry ≤ 32 KiB, only per-product keys), AS-84 timeouts (table lock → cold read `503` within 3 s, warm still served), plus SC-003/SC-005 assertions.

### Implementation

- [X] T041 [US2] Create `D/application/public-product.service.ts`: `getOrLoad` from `CacheService` (versioned entries, SWR 60/300 s, negative 10 s, ±10% jitter, single flight, hot-key L1 ≤ 1 s, 250 ms store timeout, 2 s DB deadline); loader applies the visibility rule in one indexed statement joining `ProductShopState`; view counted only after visibility is known, on `200` and `304`, through `WriteBehindCounter` (cache down → read ok, not counted, logged); `getBatch` uses `getOrLoadMany` with one statement for all misses and returns `null` for invisible.
- [X] T042 [US2] Create `D/api/public-product.controller.ts` (`GET /products/:productId`, `Firewall({anonymous:true})`, UUID param validated before any cache/DB access, `VersionEtagInterceptor`, `Cache-Control` headers via `buildCacheControl`, `404` with `s-maxage=5`, `@RateLimit('catalog.product-read.ip')` fail open) and rewrite `D/api/product-batch-read.controller.ts` to one service call, no `@InjectConnection`, no `skipThrottle`, `catalog.batch-read.ip`, ≤ 100 ids (A15). Add the two policies to `D/rate-limit-policies.ts` and export `catalogRatePolicies` (keep `search.query` declared until S32).
- [X] T043 [US2] Move `D/product.module.ts` / `D/batch-read.module.ts` wiring (core hosts both); delete the old `product-dto.service.ts` SQL use from the controller path (the `ProductDtoService` thin adapter over the repository stays until S24). Run `$S libs/domains/catalog/product-read` then `$S libs/domains/catalog/product-cache` until green.

---

## Phase 5: User Story 3 — A change shows up promptly and never goes back (P1)

**Goal**: delete-on-write plus version-guarded, coalescing event-driven invalidation.
**Independent test**: `$S libs/domains/catalog/product-invalidation` (AS-39…AS-47).
**Gaps**: A10, A11; S52 follow-up (`invalidateIfOlder`); S53 follow-up (replace `KafkaTopicGroup` use in the projectors, adopt envelope fields).

### Tests first

- [X] T044 [US3] `D/product-invalidation.e2e-spec.ts` (`describe('Product cache invalidation')`): AS-39 delete-on-write (after each kind of write the entry is gone before the response; immediate read fresh), AS-40 event-driven (writer delete failed with cache down; event repairs; own consumer group), AS-41 duplicate event (delivered twice: one `applied`, one `skipped`, no extra miss), AS-42 out-of-order (v5 then v4: v4 ignored).
- [X] T045 [US3] Same file: AS-43 slow reader race (gated loader stores v3 after v4 invalidation → refused by the minimum version), AS-44 invalid event (bad `aggregateId`, unknown type, bad payload in a batch → DLQ, rest applied), AS-45 coalescing (10 events/3 products → 3 invalidations with highest versions), AS-46 lag (histogram value; p99 under 5 s over 100 events), AS-47 `catalog.product_deleted` (entry removed, next read `404`, positive and negative entries gone).

### Implementation

- [X] T046 [US3] Rewrite `D/infra/product-cache-invalidator.projector.ts` on the `Projector` base: own consumer group `product-cache-invalidator`, `handles` the five snapshot events + legacy `catalog.product_changed` (legacy = unconditional `invalidate`, never uses its `aggregateVersion`), `aggregateIdSchema: z.string().uuid()`, coalescing per `productVersion`, `invalidateIfOlder`, DLQ on poison without blocking the batch, lag histogram from `occurredAt`; delete `KafkaTopicGroup` use.
- [X] T047 [US3] Create `D/product-projector.module.ts` (`ProductProjectorModule`), add it to `apps/projector/src/*.module.ts` and drop `ProductSearchProjector` from the apps' composition; delete `D/infra/product-search.projector.ts` (A17; S32 follow-up already in gaps.md) and fix imports. Run `$S libs/domains/catalog/product-invalidation` and re-run `product-cache` until green.

---

## Phase 6: User Story 4 — Other domains use products only through this capability (P1)

**Goal**: R1 services `ProductQueryService`, `ProductStockService`, `ProductImportService`, `ProductCommandService` and a model-free entry point.
**Independent test**: `$S libs/domains/catalog/product-query-stock`, `…/product-import`, `…/product-boundary`.
**Gaps**: A18, A19, A20, A23, A7, D-6, D-7, D-8, D-12, D-15, D-16; hand-over table C.

### Tests first

- [X] T048 [US4] `D/product-query-stock.e2e-spec.ts` (`describe('Product query and stock services')`, test module importing only `@app/domains/catalog`): AS-48 batch R1 (map, archived included, one statement, empty = no statement, 501 refused, non-UUID `ValidationError`), AS-49 source of truth (stale entry vs `getProductsByIds`), AS-50 tenant predicate (`{shopId}` filters).
- [X] T049 [US4] Same file: AS-51 stock delta applied (row, operation record, `catalog.product_updated` with `changedFields:["quantity"]`, cache entry deleted), AS-52 insufficient stock atomic (two-item call, nothing applied incl. operation rows), AS-53 no oversell (`Promise.all` 10 × `-1` on 5; 2 × `-3` on 5; SC-002 1,000 requests / 100 units), AS-54 idempotent replay (replay and conflicting replay → `StockOperationConflictError`), AS-55 concurrent replay, AS-56 unavailable and foreign (archived negative `unavailable`, positive applies, wrong shop/unknown `not_found`), AS-57 input limits table, AS-58 storage backstop (reuse T009 assertions).
- [X] T050 [US4] `D/product-import.e2e-spec.ts` (`describe('Product external upsert and commands')`): AS-60 external upsert (created/unchanged/updated), AS-61 concurrent upsert (`Promise.all` same sku → one row, no unique error), AS-62 per-item results (3 valid + 2 invalid, limits 1–500), AS-63 upsert rules (archived stays archived, no quantity unless carried, same sku in two shops, inactive shop → `ShopNotActiveError`), AS-64 command parity (same errors/events as HTTP; controllers call only these services).
- [X] T051 [US4] `D/product-events.e2e-spec.ts` AS-65 operation retention (purge job with frozen clock: 5,000 per run oldest first, 30-day cut-off; also deletes `ProductViewBatch` > 7 days).
- [X] T052 [US4] `D/product-boundary.e2e-spec.ts` (`describe('Catalog module boundary')`): AS-86 a test module importing only `@app/domains/catalog` compiles and resolves every R1 service; the transitional export list is pinned so it can only shrink; AS-87 catalog modules alone answer `404` for `GET /products/search` and `GET /shops/:shopId/products/search`.

### Implementation

- [X] T053 [P] [US4] Create `D/infra/stock-operation.repository.ts` (`INSERT … ON CONFLICT ("operationId") DO NOTHING RETURNING`; replay read compares `productId`/`shopId`/`delta`) and `D/application/product-query.service.ts` (`getProductsByIds(ids, {shopId?})`: database only, `WHERE id = ANY(:ids) [AND "shopId" = :shopId]`, ≤ 500, duplicates collapse).
- [X] T054 [US4] Create `D/application/product-stock.service.ts` per `contracts/services.md` (1–100 ops, distinct `operationId`, items sorted by `productId`; one `TransactionRunner.run`; conditional `UPDATE … SET quantity = quantity + :d … AND quantity + :d BETWEEN 0 AND 1000000000 [AND status='ACTIVE' when :d < 0]`; zero rows classified with one read; any failure rolls back whole call and returns `{outcome:'rejected', failures}`; one `catalog.product_updated` per product through `OutboxService.append`; after commit `invalidateIfOlder` with concurrency 20). Metric `catalog_stock_operation_total`.
- [X] T055 [US4] Create `D/application/product-import.service.ts` (`upsertFromExternal(shopId, items, source)`, 1–500 items; `ShopNotActiveError` before any write; per-item validation; `INSERT … ON CONFLICT ("shopId","externalSku") WHERE "externalSku" IS NOT NULL DO UPDATE … WHERE (changed columns differ) RETURNING (xmax = 0) AS inserted`; unchanged = no bump, no event; archived keeps status; `quantity` only when carried; created → `product_created`, changed → `product_updated`).
- [X] T056 [US4] Create purge job `products.purge-stock-operations` in `D/infra/product-maintenance.jobs.ts` (daily, `concurrency: 1, fleetConcurrency: 1`, 5,000 per run oldest first, 30-day cut-off from `CLOCK`, also `ProductViewBatch` > 7 days) with `declareJobType` payload contract next to the `JobPayloads` augmentation; `upsertSchedule` wrapped to catch `InvalidScheduleError` (log, not generic `Error`).
- [X] T057 [US4] Rewrite `D/application/drafts.service.ts` product parts only (A23, S06 owns the rest): publish path calls `ProductCommandService.update`; remove the `UPDATE "Product"` / `SELECT … "Product"` SQL, the `outboxService.notify` call and the `ShopMembership` SQL (use `ShopAccessService.assertMember`, resolves the third `catalog` finding); keep collab specs green.
- [X] T058 [US4] Rewrite `D/index.ts`: export modules (`ProductModule`, `ProductBatchReadModule`, `ProductWorkerModule`, `ProductProjectorModule`), R1 services, DTO/view types, error classes, five event definitions, `catalogRatePolicies`; remove `ProductCacheInvalidator`, `ProductSearchProjector`; keep a clearly commented `// TRANSITIONAL` block (`ProductModel`, `ProductDtoModule`, `ProductDtoService`, `ProductService`, `ProductChanged`, `productChanged`, `PRODUCTS_AGGREGATE`, `CollabModule`, `DraftsModule`). Make `ProductDtoService`/`ProductDtoModule` a thin adapter over the repository (no SQL of its own). Fix compile in sibling importers only if forced and minimal (see T080).
- [X] T059 [US4] Run `$S libs/domains/catalog/product-query-stock`, `…/product-import`, `…/product-boundary`, and the AS-65 case of `…/product-events`; fix until green. Run `pnpm check:boundaries` and `pnpm check:table-ownership` (catalog findings must be 0).

---

## Phase 7: User Story 5 — View counts are cheap and approximately right (P2)

**Goal**: chunked, idempotent, single-fleet-run view flush on `claim`/`commit`.
**Independent test**: `$S libs/domains/catalog/product-views` (AS-66…AS-75).
**Gaps**: A14; S52 follow-up (`claim`/`commit`, apply idempotent by `batchId`; counter name `counter:{product-views}:pending`); S49 follow-up (`fleetConcurrency: 1`, `declareJobType`, `InvalidScheduleError`).

### Tests first

- [ ] T060 [US5] `D/product-views.e2e-spec.ts` (`describe('Product views write-behind')`): AS-66 count and flush (5 views → flush → row `viewCount` +5 and pending empty; `version` and `updatedAt` unchanged), AS-67 flush failure (trigger raises on `UPDATE` of the product table → claim restored → exact 5 afterwards), AS-68 views during a flush (concurrent reads and claim; nothing lost or double counted), AS-69 chunks (2,500 products → 3 statements of ≤ 1,000; failure in chunk 2 leaves chunk 1 applied and a replay skips it via `ProductViewBatch`), AS-70 deleted product (no poison; other members applied), poison non-UUID member skipped and counted.
- [ ] T061 [US5] Same file: AS-71 two workers (two concurrent runs → counts applied once), AS-72 cache down (read ok, not counted, logged), AS-73 not counted (`404`, `400`, `429`, hidden, batch), AS-74 no write amplification (no outbox row, no entry deleted, versions unchanged), AS-75 schedule (registered with 10 s cron; one run per tick with two schedulers; `fleetConcurrency: 1`).

### Implementation

- [ ] T062 [US5] Create `D/infra/view-batch.repository.ts` and `D/application/product-views.service.ts`: `count(productId)` (cache failure swallowed, logged, metric); `flush()` uses `WriteBehindCounter.claim()` then chunks of 1,000, each chunk in one `TransactionRunner.run` that inserts the `(batchId, chunk)` marker (skip chunk if present) and runs one parameterised `UPDATE "Product" … FROM unnest(:ids::uuid[], :deltas::int[])` that touches only `viewCount`; non-UUID members dropped and counted; `commit(batchId)` only when every chunk is applied; on failure leave the claim for reclaim (no `drain`/`restore`).
- [ ] T063 [US5] Rewrite `D/infra/product-views.jobs.ts`: job `products.flush-view-counts` (`concurrency: 1, fleetConcurrency: 1, leaseMs: 30_000`), `declareJobType` with zod payload next to the `JobPayloads` augmentation, `upsertSchedule` every 10 s with `InvalidScheduleError` caught and logged. Create `D/product-worker.module.ts` (`ProductWorkerModule`) hosting the jobs; add to `apps/worker`. Run `$S libs/domains/catalog/product-views` until green.

---

## Phase 8: User Story 6 — The catalog follows the shop's life (P2)

**Goal**: shop status/deleted consumers, sweep and purge jobs, shop-id backfill, contract migrations.
**Independent test**: `$S libs/domains/catalog/product-shop-lifecycle` (AS-76…AS-81).
**Gaps**: A21, A22, A16 (contract); S03 follow-ups (call `ShopProvisioningService.ensureShopsForLegacySellers` ≤ 200, own `NOT NULL` on `Product.shopId`, drop FK `Product.shopId → Shop`); S01 follow-up (FK to `User` dropped); S49 (`declareJobType`, `fleetConcurrency: 1`).

### Tests first

- [ ] T064 [US6] `D/product-shop-lifecycle.e2e-spec.ts` (`describe('Product and shop lifecycle')`): AS-76 suspension hides products (2,500 products, `drop-shop-entries` batches ≤ 1,000, products `404` publicly, reinstate restores, stale `shopVersion` ignored), AS-77 shop purge (`tenancy.shop_deleted`: batches ≤ 500, `catalog.product_deleted` events with `aggregateVersion` last+1, history/operations/shop-state gone, other shops intact, duplicate delivery, resume after a mid-run failure), AS-78 invalid shop events (DLQ, no side effect).
- [ ] T065 [US6] Same file: AS-79 shop-id backfill (≤ 200 sellers per call through `ensureShopsForLegacySellers`, batches, `catalog.product_updated` with `changedFields:["shopId"]`, rerun is a no-op, concurrent runs safe, `catalog_backfill_orphans` gauge), AS-80 ownership constraints (after backfill + contract migrations `shopId` is `NOT NULL`; no FK to `Shop` or `User`; `quantity` and `version` checks validated; `Product_shopId_not_null` check dropped), AS-81 sandbox shops (flag stamped at create, in events, never public).

### Implementation

- [ ] T066 [P] [US6] Create `D/infra/shop-state.repository.ts` and consumers `D/infra/shop-status.consumer.ts` (group `product-shop-status`, `versionGuard` on `shopVersion`, upsert `ProductShopState`, enqueue `products.drop-shop-entries`) and `D/infra/shop-deleted.consumer.ts` (group `product-shop-deleted`, mark `DELETED`, enqueue `products.purge-shop` with per-shop idempotency key); `handles` the tenancy event contracts `ShopStatusChanged`/`ShopDeleted` from the tenancy entry point; poison → DLQ.
- [ ] T067 [US6] Create `D/application/shop-listing.service.ts` and jobs in `D/infra/product-maintenance.jobs.ts`: `products.drop-shop-entries` (resumable keyset sweep ≤ 1,000 per batch, `invalidateIfOlder`/`invalidate` per product), `products.purge-shop` (≤ 500 products per transaction: delete rows + history + stock operations + emit `catalog.product_deleted` via `OutboxService.append`; last run deletes the `ProductShopState` row; `fleetConcurrency: 1` per shop key); each with `declareJobType` payload contract; register consumers in `ProductProjectorModule` and jobs in `ProductWorkerModule`.
- [ ] T068 [US6] Create `D/application/product-backfill.service.ts` and job `products.backfill-shop-ids` (enqueued at worker boot with `idempotencyKey: 'catalog-backfill'`, self re-enqueue, `fleetConcurrency: 1, leaseMs: 300_000`, `declareJobType`): per run take ≤ 200 distinct legacy `sellerId` with `shopId IS NULL`, call `ShopProvisioningService.ensureShopsForLegacySellers`, update products in batches via the version-bumping path with `catalog.product_updated` (`changedFields:["shopId"]`); publish `catalog_backfill_orphans`.
- [ ] T069 [US6] Migration `…-catalog-s05-contract-fks.js`: drop `Product_sellerId_fkey` and `Product_shopId_fkey` (each with `lock_timeout`, one step each). Migration `…-catalog-s05-contract-shop-not-null.js`: refuse to run while any `shopId IS NULL` row exists; `CHECK ("shopId" IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` → drop the check; drop S03's `Product_shopId_not_null` check; `VALIDATE` the `quantity` and `version` checks. Both are separate deploy steps (order in quickstart "Prerequisites").
- [ ] T070 [US6] Run `$S libs/domains/catalog/product-shop-lifecycle` until green; add the `S03` follow-up note (tenancy can drop its `Product` SQL, must not rely on `ON DELETE` cascade) — already in `gaps.md`; verify it still reads true.

---

## Phase 9: User Story 7 — The contract with the rest of the system is exact (P3)

**Goal**: events, atomicity, timeouts, observability and boundary proven end-to-end.
**Independent test**: `$S libs/domains/catalog/product-events`, `…/product-boundary`, static gates.

- [ ] T071 [US7] Extend `D/product-events.e2e-spec.ts` so AS-82 covers every producer (create, update, archive, restore, stock delta, import, backfill, purge) and AS-83 covers stock and import writes too (outbox trigger → rollback of operation rows and product rows); AS-85 asserts every metric of T017 moves and no metric carries an id label.
- [ ] T072 [US7] Add structured logging with `requestId` and no bodies to the services; ensure problem+json members (`code`, `status`, `type`) for every error in `contracts/http.md`; run `$S libs/domains/catalog/product-events` until green.
- [ ] T073 [US7] Static gates (AS-86): `npx tsc --noEmit -p tsconfig.json && (cd ../contracts && npx tsc --noEmit)`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:no-wallclock`, `pnpm check:table-ownership --strict` (catalog 3 → 0; other domains' `Product` findings expected to remain). Record the numbers.

---

## Phase 10: Boundary, adjacent edits, polish (WP-10, WP-12)

- [ ] T074 Do NOT delete `D/product.e2e-spec.ts` (the gate forbids deleting a test; it is rewritten and its search cases call `ElasticsearchService.searchProducts`, see `gaps.md` Gate repairs). Remaining: `D/infra/product-dto.service.ts` SQL if any remains, and keep `ProductDtoService` only as the thin adapter; confirm no `infra/` import in `api/` or `application/` (grep).
- [ ] T075 [P] Adjacent edit: `packages/backend/libs/domains/assistant/application/assistant-tools.ts` — search through `ElasticsearchService.searchProducts` instead of `ProductService.search` (the only forced sibling source edit; touch nothing else there).
- [ ] T076 [P] Adjacent edit: `packages/web/lib/api/shops.ts` (`useCreateProduct`, `useShopProducts`: routes `/shops/:shopId/products…`, `priceMinor`, `currency`, required `expectedVersion`) and `packages/web/lib/api/catalog.ts` (`ProductDetail` follows `productPublicSchema`); types only, no screen redesign; update README route list if it names removed routes. Run the web type check.
- [ ] T077 Verify the stale-test hazards after the old `cache.e2e-spec.ts` deletion: confirm `packages/backend/libs/infrastructure/cache` has no import of `ProductModule`, and that `product-read` T037 covers ETag/`304`/negative cache/view count (S52 follow-up (a)).
- [ ] T078 [P] Deploy notes in `quickstart.md`: confirm the Redis key rename note (`wb:{product-views}` → `counter:{product-views}:pending`, loss ≤ one flush interval; S52 follow-up (b)), `product:v1:*` expiry, removed routes, orphan products blocking the NOT NULL contract migration.

---

## Final Phase: Verification and reporting

- [ ] T079 Run the whole capability once: `$S libs/domains/catalog` (collab and drafts specs included, must stay green). Fix regressions, then re-run only the failing file.
- [ ] T080 Run the sibling suites that import catalog exports and may break from the transitional changes (only the ones that compile against `ProductModel`/`ProductDtoService`): `$S libs/domains/orders`, `$S libs/domains/tenancy`; if a failure is caused by this change, fix it in catalog (compat export); if it needs a sibling edit, add a bullet to gaps.md instead of editing the sibling.
- [ ] T081 Reconcile `gaps.md`: tick every A1–A26 / B / C item to its task (A1→T033/T034, A2→T034, A3→T034, A4→T008/T034, A5→T041, A6→T042, A7→T034/T035, A8→T018, A9→T031, A10→T046, A11→T032/T033, A12→T041, A13→T041, A14→T062, A15→T042, A16→T013/T069, A17→T047, A18→T054, A19→T053–T055, A20→T058, A21→T066/T067, A22→T068, A23→T057, A24→T016/T017, A25→T020–T071, A26→T033); keep `## Sibling-spec follow-ups` (S03, S06, S07–S09, S10/S11/S13/S21, S12…, S16, S19/S25/S26/S40/S43, S32, S42, S48, W02/W04, S50, S18) up to date with anything new found in T080.
- [ ] T082 Unverified criteria: confirm `quickstart.md` "Ops artifacts" and `specs/UNVERIFIED.md` rows exist for SC-004, SC-007, SC-008, SC-009 with status `not run` (they do today; fix the stray blank line breaking the table before SC-009 in `quickstart.md`); add a row for any other SC-nnn that no test proves.
- [ ] T083 Final report (to the user, in the run summary): list the follow-ups handled — S01 FK drop (T013, T069), S03 `ensureShopsForLegacySellers` ≤ 200 / `NOT NULL` / FK drop (T068, T069), S49 `declareJobType` + `InvalidScheduleError` + `fleetConcurrency: 1` (T056, T063, T067, T068), S52 `claim`/`commit` idempotent by `batchId`, `getOrLoadMany`, `invalidateIfOlder` (T041, T046, T062), S52 (a)(b)(c) (T037, T078, T003), S53 `latest-per-key`, full-state events, `aggregateVersion`, `OutboxService.append`, `notify`/`KafkaTopicGroup` removal (T031, T033, T046, T057); numbers from T001 vs T073; direct `sequelize.transaction` sites 0 → 0; what remains unverified.

---

## Dependencies & execution order

- Phase 1 → Phase 2 (blocks everything) → US1 (MVP) → US2 → US3 → US4 → US5 → US6 → US7 → Phase 10 → Final.
- US2 needs US1 (`ProductCommandService` for update/archive in read tests). US3 needs US1 and US2 (cache keys, loader). US4 needs US1 (events, repository); T057/T058 need US1–US3 done. US5 needs US2 (view counting hook). US6 needs US1 and US3 (consumers share the projector module). US7 extends tests across US1–US6.
- Within a story: tests (fail) → repositories → services → controllers/jobs → wiring → run narrow test.
- T069 (contract migrations) only after T068 and the backfill test pass.

## Parallel opportunities

- Phase 1: T002, T003, T004, T005 together.
- Phase 2: unit specs T006–T008 together; models T013/T014 together; pure modules T015–T017 together once specs exist.
- US1: test tasks T020–T029 all in different describe blocks of two files (write in parallel per file); T030–T032 parallel.
- US4: T048–T052 parallel (different files); T053 parallel with T055.
- US6: T066 parallel with T068's service.
- Phase 10: T075, T076, T078 parallel.

## Implementation strategy

- **MVP = Phases 1–3 (US1)**: a member can create, edit, list, archive and restore products with OCC and full-state events. Ship behind the expand migrations only.
- Then P1 increments US2 → US3 → US4 (each independently testable with its named command), then P2 US5/US6, then P3 US7 and polish.
- Deploy order (quickstart): expand migrations → code → backfill job to zero orphans → contract migrations.

## Task counts

Total 83. Setup 5 (T001–T005), Foundational 14 (T006–T019), US1 17 (T020–T036), US2 7 (T037–T043), US3 4 (T044–T047), US4 12 (T048–T059), US5 4 (T060–T063), US6 7 (T064–T070), US7 3 (T071–T073), Phase 10 5 (T074–T078), Final 5 (T079–T083).

## Phase 11: Convergence

- [ ] T084 [US4] Finish the second half of T035: after T075 moves `assistant-tools.ts` to `ElasticsearchService.searchProducts`, remove the `ElasticsearchService` injection and `search` from `libs/domains/catalog/application/product.service.ts`, so the catalog no longer imports the Elasticsearch infrastructure, per plan: WP-12 / A7 / D-16 / AS-87 (partial). MEDIUM; deferred to the final pass with T075, as recorded in `gaps.md`.
