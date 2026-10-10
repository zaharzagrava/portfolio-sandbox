# Tasks: S32 — Product Search (domain `discovery`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `data-model.md`, `research.md`, `contracts/http-api.md`, `contracts/events-and-ports.md`, `quickstart.md`, constitution v3.1.0.

**Tests**: required. For every `test-plan.md` row the failing test task comes **before** the code task. Run backend commands from `packages/backend` through `../../scripts/sdd/test-spec.sh <path>`; narrowest test first, whole `libs/domains/discovery` suite once at the end. If a test still fails after 5 fix attempts: write the blocker, attempts and hypothesis into `questions.md` and stop.

**Rules for every task**: never use `git checkout/restore/reset/stash/clean` (undo by hand-editing only the named lines); no new `sequelize.transaction` (use `TransactionRunner.run` / `@Transactional`; discovery has no `// S54 T037 audit` site today, re-grep when touching a file); no `ProductModel`/`ShopModel`/`ShopMembershipModel`/`MembershipService` or raw SQL on foreign tables in discovery search code. Paths are relative to `packages/backend/libs/domains/discovery/` (written `D/`) unless stated. Scenario IDs (AS-nn) are in `spec.md`; e2e file keys are in `test-plan.md`.

## Format: `- [ ] Txxx [P] [USn] Description with file path` — `[P]` = different files, no dependency on an incomplete task.

User stories: US1 public search (P1 route) · US2 facets (P2) · US3 semantic (P2) · US4 index projection (P1) · US5 zero-downtime reindex (P1) · US6 synonyms (P2) · US7 shop search (P2) · US8 measurement (P3) · US9 platform/exported services (P3).

---

## Phase 1: Setup

- [ ] T001 Run `pnpm --dir packages/backend check:table-ownership` and `pnpm --dir packages/backend check:boundaries`; replace section C of `specs/domains/S32-product-search/gaps.md` with the exact output of the first (any line not already listed is a new gap and gets its own task appended to this file).
- [ ] T002 [P] Add config keys validated at startup in the backend config module (find with `grep -rn jwt_secret packages/backend/src packages/backend/libs/infrastructure`): `search_log_secret` (must differ from `jwt_secret`), `search_id_signing_key`, `search_budget_ms` (1000), `embedding_budget_ms` (300), `search_refresh_interval` ('5s'), `search_tombstone_retention_days` (30), `search_previous_index_retention_hours` (24), `search_boost_weights` (defaults of FR-005, total multiplier cap 4); add values to the test env files.
- [ ] T003 [P] Confirm the test stack is up (`docker compose -f docker-compose.test.yaml up -d`: Postgres, Redis, Redpanda, Elasticsearch 8.15.3, ClickHouse) and that `scripts/sdd/test-spec.sh` runs an existing discovery spec; note the result in the final report.

---

## Phase 2: Foundational (blocks all stories)

### Ownership and schema

- [ ] T004 Register six tables in `packages/backend/db/ownership.ts` for `domain:discovery` (`SearchShopProduct`, `SearchShopState`, `SearchReindexRun`, `SearchReindexRunHistory`, `SearchSynonymSet`, `SearchSynonymVersion`) and add them to `docs/architecture/domain-map.md` in the same change; match the key format already used in the registry.
- [ ] T005 Migration in `packages/backend/migrations/` (expand-only, `SET lock_timeout`) creating `SearchShopProduct`: `productId` uuid PK; `shopId` uuid NOT NULL; `title` text NOT NULL; `brand` text NULL; `status` text NOT NULL CHECK `ACTIVE|ARCHIVED`; `priceMinor` bigint NOT NULL CHECK ≥ 0; `currency` char(3) NOT NULL; `quantity` integer NOT NULL; `isSandbox` boolean NOT NULL; `productVersion` bigint NOT NULL; `deletedAt` timestamptz NULL; `updatedAt` timestamptz NOT NULL; `searchVector` tsvector GENERATED ALWAYS AS (`to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(brand,''))`) STORED; indexes: GIN `searchVector`, GIN `lower(title) gin_trgm_ops`, btree `(shopId, status)` partial `WHERE deletedAt IS NULL`, btree `(deletedAt)` partial `WHERE deletedAt IS NOT NULL`.
- [ ] T006 [P] Migration creating `SearchShopState`: `shopId` uuid PK; `status` text (`ACTIVE|SUSPENDED|DELETING|DELETED`); `plan` text NULL (`STARTER|PRO|ENTERPRISE`); `shopVersion` bigint NULL; `offboarding` boolean NOT NULL default false; `lastEventAt` timestamptz NOT NULL; `lock_timeout` set.
- [ ] T007 [P] Migration creating `SearchReindexRun` (`runId` uuid PK; `kind` `REINDEX|ROLLBACK`; `status` CHECK `QUEUED,BUILDING,CATCHING_UP,COMPLETED,FAILED,CANCELLED`; `mappingVersion` int; `embeddingModelVersion` text; `index`, `previousIndex` text NULL; `previousRetiresAt` timestamptz NULL; `replayPosition` jsonb; `documents` bigint NOT NULL default 0; `ledger` jsonb; `failureReason` text NULL; `switchingAt` timestamptz NULL; `requestedBy` uuid; `startedAt`, `finishedAt`, `createdAt` timestamptz) with partial unique index `ON ((true)) WHERE status IN ('QUEUED','BUILDING','CATCHING_UP')` and index `(createdAt DESC, runId DESC)`; and `SearchReindexRunHistory` (`historyId` bigint identity PK; `runId` uuid; `fromStatus` text NULL; `toStatus` text; `at` timestamptz; `detail` jsonb; index `(runId, historyId)`).
- [ ] T008 [P] Migration creating `SearchSynonymSet` (`id` smallint PK CHECK = 1; `version` int NOT NULL; `rules` text[] NOT NULL; `updatedBy` uuid NULL; `updatedAt` timestamptz; `pendingVersion` int NULL; `pendingRules` text[] NULL; `pendingAt` timestamptz NULL) and `SearchSynonymVersion` (`version` int PK; `rules` text[]; `updatedBy` uuid; `createdAt` timestamptz); data step seeds version 1 from the old code defaults (`libs/infrastructure/elasticsearch/elasticsearch.service.ts:13`).
- [ ] T009 [P] ClickHouse migration under `packages/backend/db/clickhouse/`: add `searchId`, `mode`, `degraded`, `surface`, `filters` columns to `search_queries` if absent; TTL 90 d on event time for `search_queries` and `search_clicks`; click dedup key `searchId + productId + position + eventId`.
- [ ] T010 Sequelize models in `D/infra/models/` for the six tables (`search-shop-product`, `search-shop-state`, `search-reindex-run`, `search-reindex-run-history`, `search-synonym-set`, `search-synonym-version` `.model.ts`), no foreign keys to other domains.

### Contracts

- [ ] T011 [P] Zod schemas in `packages/contracts/src/search/product-search.ts`: `productSearchQuerySchema` (`q?` ≤ 100 after normalisation; `category?`, `brand?` ≤ 100; `minPriceMinor?`, `maxPriceMinor?` integers ≥ 0; `minRating?` 0–5; `inStock?` `'true'|'false'` only; `sort?` `relevance|price-asc|price-desc|newest`; `facets?`, `semantic?` `'true'|'false'`; `limit?` 1–50 default 20; `cursor?`; strict, unknown keys rejected) and `productSearchResponseSchema` (`{searchId, mode: browse|lexical|semantic, items[{id, shopId, title, brand, category, priceMinor, currency, rating, inStock, imageUrl, sponsored, position}], total{value, exact}, nextCursor, facets?{categories, brands, priceRanges, avgRating}, degraded: string[]}`).
- [ ] T012 [P] Zod schemas in `packages/contracts/src/search/shop-product-search.ts`: `shopProductSearchQuerySchema` (`q` required 1–100, `status?` `ACTIVE|ARCHIVED`, `limit?` 1–50 default 25, `cursor?`, strict) and `shopProductSearchResponseSchema` (`{items[{id, title, priceMinor, currency, quantity, status, rank}], nextCursor}`).
- [ ] T013 [P] Zod schemas in `packages/contracts/src/search/admin.ts`: `reindexRunSchema`, `searchIndexStatusSchema` (fields per AS-77 in spec.md), `synonymsPutRequestSchema` (`{rules: string[], expectedVersion: int}`), `synonymsSchema` (`{version, rules, updatedAt, updatedBy}`), `searchQualityReportSchema` (rows `{query, searches, ctr, mrr, zeroResultRate}`; query params `days` 1–90 default 7, `limit` 1–100 default 50).
- [ ] T014 [P] Zod schemas in `packages/contracts/src/search/click.ts` (`searchClickRequestSchema` `{searchId, productId uuid, position int 0–99}`) and `events.ts` (`searchEventSchemas` for `search.performed`, `search.result_clicked`, `search.reindex_completed` payloads from `contracts/events-and-ports.md`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`); `index.ts` re-exported from `packages/contracts/index.ts`; parity fixtures for the events next to the existing contract fixtures.
- [ ] T015 Run `npx tsc --noEmit -p packages/contracts` and fix.

### Engine split and ports (D-16, D-6)

- [ ] T016 Create `packages/backend/libs/infrastructure/elasticsearch/search-engine.client.ts` (`SearchEngineClient`: search, mget, bulk, count, index/alias create/exists/swap/delete, update-by-query, delete-by-query, synonyms API; explicit per-call timeout; no product names) and `search-engine.errors.ts` (typed timeout / unavailable / rejected); `elasticsearch.module.ts` exports `SearchEngineClient`.
- [ ] T017 Move product knowledge out of `libs/infrastructure/elasticsearch/elasticsearch.service.ts` into `D/infra/product-index.adapter.ts` (`productsIndexDefinition`, `searchProducts`, `suggestTitles`, `bulkUpsertProducts`, `ensureProductsIndex`, `stubEmbed`, `PRODUCTS_INDEX`, `SYNONYMS_SET`, `PRODUCT_EMBEDDING_DIMS`, `types.ts`) behind `ProductIndexPort`; keep the old service compiling until callers are rewired, then delete it (T108).
- [ ] T018 Rewire `EsVersionedSink` (`libs/infrastructure/projections/sinks`) to `SearchEngineClient`; run `../../scripts/sdd/test-spec.sh libs/infrastructure/projections/versioned-sinks` (must stay green).
- [ ] T019 [P] Rewire `fulfilment/infra/pickup-availability.projector.ts` and `fulfilment/infra/availability-index.ts` to `SearchEngineClient` (edit only injection and call sites); run the fulfilment pickup spec(s) found with `grep -rl pickup packages/backend/libs/domains/fulfilment --include=*e2e-spec.ts`.
- [ ] T020 `D/domain/ports.ts` with injection tokens: `ProductIndexPort`, `ShopSearchRepository`, `ReindexRunRepository`, `SynonymSetRepository`, `ShopStateRepository`, `EmbeddingProvider`, `ProductImageResolver`, `SearchEventPublisher`, `Clock`; domain files import no Nest, Sequelize, kafkajs or ES client.

### Pure domain, test-first

- [ ] T021 [P] Failing `it.each` unit spec `D/domain/projection-guard.spec.ts` (AS-81, stored × incoming × kind; `assertNever`) plus a `fast-check` permutation/duplicate property (SC-004: any permutation with duplicates ends at the newest version; delete tombstone rules).
- [ ] T022 [P] Failing unit spec `D/domain/reindex-run-status.spec.ts` (AS-82, every pair of the 6 statuses; legal edges `QUEUED→BUILDING|CANCELLED`, `BUILDING→CATCHING_UP|FAILED|CANCELLED`, `CATCHING_UP→COMPLETED|FAILED|CANCELLED`; `assertNever`).
- [ ] T023 [P] Failing unit spec `D/domain/synonym-rules.spec.ts` (AS-83; valid: one-way `a => b`, two-way `a, b`, multi-word; each invalid class with its code; ≤ 5,000 rules).
- [ ] T024 [P] Failing unit spec `D/domain/search-cursor.spec.ts` (AS-84; round trip `{sv, id, fp}` base64url, fingerprint mismatch, tampering, no physical index name inside).
- [ ] T025 [P] Failing unit spec `D/domain/query-text.spec.ts` (AS-85; normalisation: fullwidth, control chars, whitespace, 100-char cap; redaction: email, digit runs, card numbers, short query).
- [ ] T026 [P] Failing unit spec `D/domain/popularity-bucket.spec.ts` (AS-86; `it.each` plus `fast-check`: monotone, bounded, boost multiplier in [1, 4]).
- [ ] T027 Implement `D/domain/projection-guard.ts` until T021 passes (per-source guards: product `productVersion`, shop-state `shopVersion` else `occurredAt`, media `galleryVersion`, sponsorship `sponsorshipVersion`, popularity `popularityAt`).
- [ ] T028 [P] Implement `D/domain/reindex-run-status.ts` until T022 passes.
- [ ] T029 [P] Implement `D/domain/synonym-rules.ts` until T023 passes.
- [ ] T030 [P] Implement `D/domain/search-cursor.ts` until T024 passes.
- [ ] T031 [P] Implement `D/domain/query-text.ts` until T025 passes.
- [ ] T032 [P] Implement `D/domain/popularity-bucket.ts` and `D/domain/boost.ts` (weights from config, total multiplier capped at 4) until T026 passes.
- [ ] T033 [P] Add `D/domain/visibility-filter.ts` (`hasProduct:true AND deleted:false AND status:ACTIVE AND shopHidden:false`), `D/domain/index-definition.ts` (mapping per data-model §2: 24 shards, 2 replicas, `refresh_interval` from config; test profile 1 shard / 0 replicas; `_meta {mappingVersion, embeddingModelVersion, createdByRun}`), `D/domain/consumed-events.ts`, `D/domain/search-errors.ts` (`SearchUnavailableError`, `SuggestionTimeoutError`, validation errors), `D/domain/search-id.ts` (HMAC-signed `searchId` with `search_id_signing_key`, expiry).
- [ ] T034 Run `../../scripts/sdd/test-spec.sh libs/domains/discovery/domain`; all six unit files green.
- [ ] T035 Shared e2e support in `packages/backend/test/` (next to existing helpers; find with `ls packages/backend/test`): event publisher helper delivering real envelopes (`catalog.product_*`, `tenancy.shop_*`, `media.gallery_changed`, `marketing.product_sponsorship_changed`) to consumer entry points; deterministic embedding test provider placing chosen phrases near each other; gate around the provider; reuse `test/fakes/tcp-fault-proxy.ts`.
- [ ] T036 [P] Rate-limit policies in `D/rate-limit-policies.ts`: `discovery.search.query` 120/min user-or-IP fail open; `discovery.shop-search` 120/min user+shop fail open; `discovery.search-click` 300/min IP fail open; `discovery.search-admin` 30/min admin fail closed; register with the S50 registry. Leave `catalogRatePolicies`' `search.query` declaration for its other call sites (S50 follow-up).
- [ ] T037 [P] `declareJobType` with zod payload contract next to the `JobPayloads` augmentation in `D/infra/search.jobs.ts` for `search.reindex {runId}`, `search.retire-previous-index {}`, `search.refresh-popularity {}`, `search.backfill-shop-state {cursor?}`, `search.backfill-embeddings {}`, `search.purge-tombstones {}`; callers catch `InvalidScheduleError` and use the discriminated `JobsService.cancel` result (S49 follow-up).
- [ ] T038 [P] Metrics on the S54 registry in `D/infra/search-metrics.ts`: `search_requests_total{mode,status}`, `search_duration_seconds`, `search_degraded_total{reason}`, `search_unavailable_total`, `search_projection_lag_seconds`, `search_stale_events_ignored_total`, `search_ignored_total{reason}`, `search_reindex_duration_seconds`, `search_reindex_failed_total`, `search_events_dropped_total`.

**Checkpoint**: schema, contracts, ports, pure logic, engine client in place; `tsc --noEmit` for backend and contracts clean.

---

## Phase 3: US4 — Index follows the catalog (P1) 🎯 MVP base

**Goal**: product, shop-state, media and sponsorship events project into the index and the shop table with per-source guards, tombstones, DLQ, coalescing. **Independent test**: `search-projection.e2e-spec.ts` green.

### Tests first (all fail before T047)

- [ ] T039 [US4] `D/search-projection.e2e-spec.ts` (describe `Search index projection`) scaffold + AS-22 (created searchable, document fields, checkpoint), AS-23 (out-of-order, stale counter, no DLQ), AS-24 (same eventId twice, other eventId same version).
- [ ] T040 [US4] Same file: AS-25 (archive / late update / restore, restore-before-archive), AS-26 (delete remembered; purge at +30 d + 1 s and not before), AS-27 (sandbox ignored, counter, no document).
- [ ] T041 [US4] Same file: AS-28 (suspend/reinstate, stale event, unknown shop, either order), AS-29 (offboarding started/cancelled ordered by `occurredAt`, `shop_deleted` purges index and shop table, later events ignored, repeat), AS-30 (PRO boost visible, old version ignored, unknown plan DLQ).
- [ ] T042 [US4] Same file: AS-31 (sponsorship flag/label, late false ignored, never reveals hidden, early arrival kept), AS-32 (image first media thumb, empty list, old version, image-before-product, product update keeps image), AS-33 (each invalid class → DLQ with no change, next message processed, unknown type ack).
- [ ] T043 [US4] Same file: AS-34 (30 updates → one engine write at v31), AS-35 (engine outage via fault proxy: not acked, backoff, recovery loses nothing, permanent rejection DLQ), AS-36 (freshness public ≤ 10 s, shop table ≤ 5 s, lag metric).
- [ ] T044 [US4] Same file: AS-37 (popularity job buckets, only changed written, version unchanged, update keeps it, concurrent runs once), AS-38 (backfill shop state R1 batch ≤ 500, suspended hidden, unknown stays active, resumable, rerun no-op), shop-table projection write rules (version guard SQL, tombstone `deletedAt`).
- [ ] T045 [US4] Same file: duplicate-delivery and invalid-payload tests (VII.4) for each consumer group `search-indexer`, `search-shop-state`, `search-media`, `search-sponsorship`.

### Implementation

- [ ] T046 [US4] Repositories in `D/infra/repositories/`: `shop-state.repository.ts` (`ShopStateRepository`) and `shop-search.repository.ts` write side (guarded `INSERT … ON CONFLICT (productId) DO UPDATE … WHERE productVersion <= EXCLUDED.productVersion AND (deletedAt IS NULL OR created with higher version)`; delete sets `deletedAt = occurredAt`), `TransactionRunner.run` where more than one statement.
- [ ] T047 [US4] Index write path in `D/infra/product-index.adapter.ts`: external-versioned bulk with partial updates per source (product / shop-state / media / sponsorship / popularity), signal-only documents (`hasProduct=false`), `browseScore` recomputed by whichever source changed an input, coalescing repeated updates per `productId`, rejected items → DLQ (never dropped), 30-day tombstone writes.
- [ ] T048 [US4] `D/infra/embedding/hash-embedding.provider.ts` (`EmbeddingProvider`, 64 dims, deterministic, `embedding_budget_ms` timeout) and `D/infra/image/{media-image.resolver,null-image.resolver}.ts` (`ProductImageResolver`; null resolver bound until S29's `MediaQueryService.getReadyMediaByIds` exists).
- [ ] T049 [US4] S53 `Projector` classes in `D/infra/projectors/`: `product-index.projector.ts` (group `search-indexer`, `products.events`, zod validation, `idempotency: 'versionGuard'` documented, `isSandbox` read from the event — no `"Shop"` SQL, embeddings only when text fields changed, `embeddingPending` on provider failure), `shop-state.projector.ts` (group `search-shop-state`, `shop.events`, `update_by_query` for the shop's documents + `SearchShopState` copy, `shopVersion` else `occurredAt`), `media.projector.ts` (local schema `media.gallery_changed v1`), `sponsorship.projector.ts` (local schema `marketing.product_sponsorship_changed v1`); DLQ, jittered backoff, unknown type ack with `search_ignored_total{reason="unknown_type"}`, `search_projection_lag_seconds`.
- [ ] T050 [US4] Jobs in `D/application/jobs/`: `refresh-popularity.job.ts` (every 15 min; popularity from `getProductsByIds(...).viewCount` via the catalog entry point; changed buckets only), `backfill-shop-state.job.ts` (`ShopQueryService.getShopsByIds` ≤ 500 per call, resumable cursor), `backfill-embeddings.job.ts` (every 10 min while pending, batch-limited), `purge-tombstones.job.ts` (daily, 30 d, index and table); register with `JobsService.upsertSchedule`.
- [ ] T051 [US4] `D/search-projector.module.ts` (projector app: the four projectors plus `search-clicks`/`search-queries` projectors) and `D/search-worker.module.ts` with the jobs above. If `catalog/infra/product-search.projector.ts` still exists, remove only the lines wiring it and add an S05 bullet to `gaps.md` Sibling-spec follow-ups.
- [ ] T052 [US4] Run `../../scripts/sdd/test-spec.sh libs/domains/discovery/search-projection` until green.

**Checkpoint**: the index and shop table follow `products.events`.

---

## Phase 4: US1 — Buyer finds a product by typing words (P1) 🎯 MVP

**Goal**: `GET /products/search` served from discovery. **Independent test**: `search-query.e2e-spec.ts` green.

### Tests first

- [ ] T053 [US1] `D/search-query.e2e-spec.ts` (describe `Public product search API`): AS-01 (200 parses `productSearchResponseSchema`, `Cache-Control: private, no-store`, no vector or score, exactly one engine query, `search.performed` emitted), AS-02 (typos, exact above fuzzy, first-letter rule, no match), AS-03 (field weights title > brand > description > tags).
- [ ] T054 [US1] Same file: AS-04 (browse: no `q`, `q=`, spaces; business order; no event), AS-05 (one boost signal at a time; missing neutral), AS-06 (boosts never bury an exact-title match), AS-07 (archived, sandbox, deleted, suspended/deleting/deleted shop hidden in items, total, facets, semantic; restore and reinstate).
- [ ] T055 [US1] Same file: AS-08 (three sorts, tie-break by id), AS-09 (20/20/5 no dup no gap, wrong query/filter/sort/altered cursor → 422 `invalid_cursor`, insert between pages), AS-10 (table-driven validation over every class incl. removed params `size|from|priceMin|priceMax|ratingMin`, 422 `invalid_price_range`, zero engine queries).
- [ ] T056 [US1] Same file: AS-11 (operators, wildcard, fullwidth, control chars, emoji), AS-12 (anonymous 200, 429 + `Retry-After`, isolation, limiter down via fault proxy fails open), AS-13 (engine refused and slow via fault proxy → 503 `search_unavailable` + `Retry-After: 1` within 1.1 s, no leak, counter, recovery), AS-14 (filter combination, order unchanged, empty result and event).
- [ ] T057 [US1] Same file: route precedence (`/products/search` served by discovery while `GET /products/:id` still works and `search` is not `400 validation_failed` from the catalog pipe) and the old catalog cases (search, price range, rating, sort by price and by newest from `catalog/product.e2e-spec.ts:66-150`) re-proven over HTTP.

### Implementation

- [ ] T058 [US1] Query builder in `D/infra/product-index.adapter.ts` (`ProductIndexPort.search`): fixed-first-character bounded fuzzy `multi_match` with field weights, `function_score` with capped boosts (stock, rating, popularity bucket, PRO/ENTERPRISE tier, sponsored), visibility filter in every query, filters, hard-coded sort allowlist with `productId` tie-break, `search_after` from the cursor, timeout `search_budget_ms`, no `suggestions` query, `total {value, exact}`.
- [ ] T059 [US1] `D/application/product-search.service.ts` (`ProductSearchService`): validate, normalise `q` with `query-text`, cursor fingerprint, exactly one engine query, map to the explicit DTO (no `_source` leak, `position`), sign `searchId`, publish `search.performed` (fire-and-forget, `search_events_dropped_total`), metrics, `SearchUnavailableError` → 503.
- [ ] T060 [US1] `D/infra/search-event.publisher.ts` (replaces `search-query-logger.ts`; `search_log_secret`, redaction via `query-text`, errors counted not thrown) bound to the `SearchEventPublisher` token.
- [ ] T061 [US1] `D/api/search.controller.ts` + `D/api/dto/` built from contracts schemas: anonymous, `@RateLimit('discovery.search.query')`, one application call, typed exceptions mapped to problem codes `validation_failed`, `invalid_price_range`, `invalid_cursor`, `semantic_requires_query`, `unsupported_combination`, `search_unavailable`.
- [ ] T062 [US1] `D/product-search.module.ts` (core: controllers + exported services; no `ProductModel`, no `forFeature([Product])`), imported before `CatalogModule` in `apps/core/src/core.module.ts`.
- [ ] T063 [US1] Catalog side: if S05 has not already, remove the search routes in `catalog/api/product.controller.ts`, the `searchProducts` call in `product.service.ts`, DTO `product.dto.ts:68-137` and catalog's import of `SearchQueryLogger`; otherwise confirm they are gone. Leave the `search` entry of `RESERVED_PRODUCT_SEGMENTS` (S05 removes it later).
- [ ] T064 [US1] Run `../../scripts/sdd/test-spec.sh libs/domains/discovery/search-query` until green.

**Checkpoint (MVP)**: US4 + US1 — events feed the index, buyers search it.

---

## Phase 5: US2 — Facets (P2)

**Independent test**: facet cases of `search-facets-semantic.e2e-spec.ts` green.

- [ ] T065 [US2] `D/search-facets-semantic.e2e-spec.ts` (describe `Search facets and semantic mode`) facet cases: AS-15 (counts over all matches, top 20, four price keys, average rounded, sums), AS-16 (category/brand/price selections keep sibling counts; `inStock` applies to all), AS-17 (absent unless `facets=true`, empty, more than 20 categories).
- [ ] T066 [US2] Facet aggregations in `D/infra/product-index.adapter.ts`: each facet computed with its own filter excluded, top 20, keyword brand fallback, `avgRating` rounded, price range keys; wire `facets=true` through `ProductSearchService` and the response mapper.
- [ ] T067 [US2] Run `../../scripts/sdd/test-spec.sh libs/domains/discovery/search-facets-semantic -t "AS-1[5-7]"` until green.

---

## Phase 6: US3 — Semantic search (P2)

- [ ] T068 [US3] Same file `search-facets-semantic.e2e-spec.ts`: AS-18 (parka found for a paraphrase; 10 of 60 with filter), AS-19 (422 `semantic_requires_query`, `unsupported_combination` with facets or cursor, vector missing, hidden excluded), AS-20 (gated provider timeout → lexical, `degraded`, `search_degraded_total`, event field), AS-21 (embedding created; price-only update does not call the provider (spy); title update recomputes; provider failure sets `embeddingPending`, backfill job fixes it).
- [ ] T069 [US3] Semantic mode in `ProductIndexPort.search`: k-NN with visibility and filters inside the knn filter, `k` ≥ limit, no lexical match-all; `ProductSearchService` embeds `q` within `embedding_budget_ms` else degrades to lexical labelled `degraded`; validation rules of AS-19.
- [ ] T070 [US3] Run `../../scripts/sdd/test-spec.sh libs/domains/discovery/search-facets-semantic` until the whole file is green.

---

## Phase 7: US5 — Zero-downtime reindex (P1)

**Independent test**: `search-reindex.e2e-spec.ts` (rewritten) and the reindex routes of `search-admin.e2e-spec.ts` green.

### Tests first

- [ ] T071 [US5] Rewrite `D/search-reindex.e2e-spec.ts` (describe `Zero-downtime search reindex`); no foreign `forFeature` model (gap C), seed through shared fixtures and the event publisher. AS-39 (202, transitions, same documents and versions, previous kept, run view, history, `search.reindex_completed`), AS-40 (50 searches/s during the run via supertest loop, 0 errors, count never below start), AS-41 (create/update/archive/delete/suspend during `BUILDING`, final equality).
- [ ] T072 [US5] Same file: AS-42 (409 `reindex_in_progress {runId}` in every active status, `Promise.all` of two triggers, rollback blocked, new run after terminal), AS-43 (cancel in each active status, cleanup, 409 `invalid_transition` on terminal, 404 `run_not_found`, 400 malformed id, cancel racing the switch), AS-44 (rejected batch and count mismatch → `FAILED`, cleanup, new run accepted, `engine_unavailable` reason).
- [ ] T073 [US5] Same file: AS-45 (lease expiry mid-build resumes once; crash after switch recovers without a second switch), AS-46 (rollback switches back with all later updates, second rollback rolls forward, 409 `no_previous_index`), AS-47 (retention before/after 24 h, parallel writes stop, never deletes live or active target).
- [ ] T074 [US5] Same file: AS-48 (legacy concrete `products` index replaced atomically while searching), AS-49 (`outdated` true then false, no startup mutation, vectors recomputed or carried), AS-50 (two instances boot → one empty index, 200 empty, status, first run fills; existing alias untouched), AS-51 (shop table rebuilt: missing rows restored, deleted absent, no older version).
- [ ] T075 [US5] `D/search-admin.e2e-spec.ts` (describe `Search administration access and status`): AS-52 over every admin route (401; 403 for owner/user/service; audit line `{actorId, action, runId|version}`; 429 past `discovery.search-admin`; fail closed with limiter down), AS-77 (`GET /admin/search/index` shape and values around a run, 401/403), list route limit/cursor with `422 invalid_cursor`.

### Implementation

- [ ] T076 [US5] `D/infra/repositories/reindex-run.repository.ts`: conditional transitions `UPDATE … WHERE runId AND status = :from` asserting one row + history row in the same `TransactionRunner.run`; keyset list by `(createdAt, runId)`; `switchingAt` claim.
- [ ] T077 [US5] `D/application/reindex/{start,cancel,rollback,get-runs}.service.ts`: start inserts `QUEUED` (unique-index violation → `409 reindex_in_progress {runId}`) and enqueues `search.reindex {runId}` via `JobsService` (stable key per run, catch `InvalidScheduleError`); cancel uses the discriminated `JobsService.cancel` result; rollback needs a retained previous index (`409 no_previous_index`).
- [ ] T078 [US5] `D/application/reindex/run-executor.service.ts` + `verify-reindex.ts`: create target `products_m<mapping>_<ts>`, enable dual-write (write set = alias target ∪ active run index ∪ retained previous index), replay `products.events` with a run-specific consumer group (`replayPosition` mirrors it), rebuild the shop table (AS-51), `CATCHING_UP` lag check, verification gate, atomic alias switch guarded by `switchingAt`, `search.reindex_completed` via the outbox in the completing transaction (no engine call inside a DB transaction), failure cleanup, resume from the run row after lease loss, heartbeat long lease.
- [ ] T079 [US5] `D/application/jobs/retire-previous-index.job.ts` (hourly; deletes the retained index after 24 h, never the live or an active target; re-pushes committed synonyms when the engine copy differs) and `D/application/reindex/index-bootstrap.service.ts` (idempotent across two instances, never touches an existing alias, converts a legacy concrete `products` index atomically); remove startup index creation from `ElasticsearchService`.
- [ ] T080 [US5] `D/application/search-index-status.service.ts` (alias target, previous, `outdated` from `_meta`, counts, active run).
- [ ] T081 [US5] Rewrite `D/api/search-admin.controller.ts`: `Firewall({roles: [ADMIN]})`, `@RateLimit('discovery.search-admin')`, routes `GET /admin/search/index`, `POST /admin/search/reindex`, `GET /admin/search/reindex`, `GET /admin/search/reindex/:runId`, `POST /admin/search/reindex/:runId/cancel`, `POST /admin/search/rollback`; one application call each; audit line without secrets or query text; problem codes `reindex_in_progress`, `run_not_found`, `invalid_transition`, `no_previous_index`.
- [ ] T082 [US5] Remove `ProductModel` use and `forFeature([Product])` from `application/search-reindex.service.ts`, `search-admin.module.ts`, `search-reindex-worker.module.ts`; delete the old service and both old modules; wire `search.reindex` and `search.retire-previous-index` handlers into `SearchWorkerModule`.
- [ ] T083 [US5] Run `../../scripts/sdd/test-spec.sh libs/domains/discovery/search-reindex` then `.../search-admin` until green.

---

## Phase 8: US6 — Synonyms (P2)

### Tests first

- [ ] T084 [US6] `D/search-synonyms.e2e-spec.ts` (describe `Search synonyms administration`): AS-53 (before/after search, 200 `{version, ruleCount, updatedAt, unchanged}`, same index, no run, no rewrite, effective ≤ 5 s), AS-54 (one-way, two-way, multi-word), AS-55 (one request per error class → 422 `invalid_synonym_rules {errors:[{index, code}]}`, state unchanged; body shape 400).
- [ ] T085 [US6] Same file: AS-56 (`Promise.all` of two edits → one 200 one 409 `synonyms_version_conflict {currentVersion}`, winner's rules, stale 409), AS-57 (same body twice → `unchanged`, stale version with identical rules, no engine call), AS-58 (engine failure via fault proxy → 503, rules and version unchanged, later success), AS-59 (rules survive a reindex), AS-60 (GET body, audit line, history pruned to 20 versions and 90 days, never below current).

### Implementation

- [ ] T086 [US6] `D/infra/repositories/synonym-set.repository.ts`: conditional claim (`pendingVersion` where `version = :expected`), commit `n+1` or clear pending; prune version table to 20 rows / 90 days.
- [ ] T087 [US6] `D/application/synonyms.service.ts`: parse with `synonym-rules`, claim → push to the engine synonyms set via `SearchEngineClient` (no DB transaction around the call) → commit; idempotent no-op path; `search_unavailable` on engine failure with state unchanged.
- [ ] T088 [US6] Add `GET/PUT /admin/search/synonyms` to `D/api/search-admin.controller.ts` with `synonymsPutRequestSchema`; audit line `{actorId, action, version}`.
- [ ] T089 [US6] Run `../../scripts/sdd/test-spec.sh libs/domains/discovery/search-synonyms` until green.

---

## Phase 9: US7 — Seller product search (P2)

### Tests first

- [ ] T090 [US7] `D/shop-product-search.e2e-spec.ts` (describe `Shop product search`): AS-61 (member lists, archived with status, status filter, shape parses `shopProductSearchResponseSchema`), AS-62 (typo trigram fallback, garbage, word cap), AS-63 (other shop's member → 404 identical to unknown, same titles in two shops stay separate), AS-64 (401, viewer 200, suspended `403 shop_suspended`, deleting `409 shop_offboarding`, deleted `404`; follows S03's implemented `ShopScoped` behaviour — record any difference in `gaps.md` before touching the spec).
- [ ] T091 [US7] Same file: AS-65 (table-driven validation incl. missing `q`, cursor misuse 422 `invalid_cursor`), AS-66 (25/25/10 paging, tie-break by id), AS-67 (create, rename, archive, restore, delete visible within 5 s; sandbox shop; shop deleted → 404), AS-68 (eight hostile strings, table intact), AS-69 (429 `discovery.shop-search`, isolation by user+shop, limiter down fails open).

### Implementation

- [ ] T092 [US7] Read side in `D/infra/repositories/shop-search.repository.ts`: `shopId` tenant predicate in every query, `deletedAt IS NULL`, full-text rank then trigram fallback with bind parameters only, keyset on `(rank, productId)`, status filter, price as `priceMinor` bigint.
- [ ] T093 [US7] Rewrite `D/application/shop-product-search.service.ts` on `ShopSearchRepository` (delete raw SQL on `"Product"`, the empty-`q` list branch and `slice(0,100)`); `D/api/shop-product-search.controller.ts` with `ShopScoped('products.read')` and `@RateLimit('discovery.shop-search')`; remove the shop-search route from the old controller; use `ShopAccessService`/`ShopQueryService`/`MembershipQueryService` only where tenancy data is needed (S03 follow-up).
- [ ] T094 [US7] Run `../../scripts/sdd/test-spec.sh libs/domains/discovery/shop-product-search` until green.

---

## Phase 10: US8 — Measurement (P3)

### Tests first

- [ ] T095 [US8] `D/search-measurement.e2e-spec.ts` (describe `Search click-through measurement`): AS-70 (202 empty body, `search.result_clicked`, click row), AS-71 (forged, altered, expired `searchId` → 422 `invalid_search_id`; bad fields 400; 429 `discovery.search-click`), AS-72 (consumer duplicate → one row, invalid → DLQ).
- [ ] T096 [US8] Same file: AS-73 (exact CTR/MRR/zero-result numbers, window, ordering, `limit`, parameter errors 400), AS-74 (email, digits, card, short query redacted; hash stability; no ids; 90-day expiry setting), AS-75 (stream down via fault proxy → search 200 / click 202 and drop counter), AS-76 (each mode and filter set parses with `searchEventSchemas`).

### Implementation

- [ ] T097 [US8] `D/application/search-click.service.ts` + `D/api/search-click.controller.ts` (`POST /search/clicks`, anonymous, `@RateLimit('discovery.search-click')`, verify signed `searchId`, publish event, never fail on stream error).
- [ ] T098 [US8] Update `D/infra/search-clicks.projector.ts` and `D/infra/search-queries.projector.ts`: zod validation, invalid → DLQ (no silent filter), dedup by `eventId`, new ClickHouse columns; keep both out of the barrel.
- [ ] T099 [US8] `D/application/search-quality.service.ts`: validated `days` (1–90) and `limit` (1–100) without silent clamping; add `GET /admin/search/quality` to `search-admin.controller.ts`.
- [ ] T100 [US8] Run `../../scripts/sdd/test-spec.sh libs/domains/discovery/search-measurement` until green.

---

## Phase 11: US9 — Platform, exported services, boundaries (P3)

- [ ] T101 [US9] `D/search-platform.e2e-spec.ts` (describe `Search exported services and module boundary`): AS-78 (test module importing only `@app/domains/discovery`; `ProductSearchService.search` same visibility, `limit ≤ 20`, `surface: 'internal'`, no cursor/facets), AS-79 (`ProductTitleSuggester.suggestTitles` visible only, size ≤ 10, abort via signal, typed `SuggestionTimeoutError`), AS-80 (`check:boundaries` and `check:table-ownership --strict` report zero findings for discovery search code; an app boots loading only `ProductSearchModule`, `SearchProjectorModule`, `SearchWorkerModule`; grep gate: no `ProductModel|ShopModel|ShopMembershipModel|MembershipService` and no `sequelize.query` on foreign tables in `D/`).
- [ ] T102 [US9] `D/application/title-suggester.service.ts` (`ProductTitleSuggester` over `ProductIndexPort` with the visibility filter); change `D/application/autocomplete.service.ts` to use it instead of `ElasticsearchService.suggestTitles` (edit only that call site).
- [ ] T103 [US9] Narrow `D/index.ts`: export `ProductSearchModule`, `SearchProjectorModule`, `SearchWorkerModule`, `ProductSearchService`, `ProductTitleSuggester`, DTO types, `SearchPerformed`, `SearchResultClicked`, `SearchReindexCompleted`; remove `SearchAdminModule`, `SearchReindexWorkerModule`, `SearchQueryLogger`, `SearchClicksProjector`, `SearchQueriesProjector`; keep `OrderBasketsProjector`, `TrendingConsumer` and existing S33–S35 exports.
- [ ] T104 [US9] Update `apps/projector/src/projector.module.ts`, `apps/core/src/core.module.ts`, `apps/worker/src/worker.module.ts` to import the three modules instead of the removed exports.
- [ ] T105 [US9] Run `../../scripts/sdd/test-spec.sh libs/domains/discovery/search-platform` until green.

---

## Phase 12: Polish and cross-cutting

- [ ] T106 [P] Web W02 port: `packages/web/lib/api/catalog.ts` types from contracts (`items`, `total.exact`, `degraded`, `nextCursor`, facet keys), `packages/web/app/search/page.tsx` sends `limit`/`cursor` (no `from`), URL state for `q`, filters, `sort`, `cursor`, sends `searchId` with each click; remove the `test.fail` "Near Me" case in `packages/web/tests/search.spec.ts:37-44`; add the happy-path journeys of `test-plan.md` (search, sort, price filter, facets, sibling remain, click) and the `seller.spec.ts` inventory search journey if that file exists.
- [ ] T107 Remove the old search cases of `catalog/product.e2e-spec.ts:66-150` if S05 left them (touch only those lines) after T057 proves them; otherwise report "already removed".
- [ ] T108 Delete the product methods and `types.ts` left in `libs/infrastructure/elasticsearch/elasticsearch.service.ts` and `SearchQueryLogger` if unreferenced; re-run `grep -rn "sequelize.transaction" packages/backend/libs/domains/discovery` to confirm no direct site was added.
- [ ] T109 Sibling-spec follow-ups: verify `gaps.md` "## Sibling-spec follow-ups" lists S05, S53, S03, S29, S36, S33, S19, S46, S50, W02/S48 and add `- **<id>**: …` bullets for anything new found while building (for example S05 leftovers from T051, T063, T107).
- [ ] T110 Unverified criteria: confirm `quickstart.md` "Ops artifacts" lists SC-001, SC-002, SC-003 (load part), SC-006, SC-010 and that the five S32 rows exist in `specs/UNVERIFIED.md` with status `not run` (they already do); add a row for any further SC no test proves. Never describe them as verified.
- [ ] T111 Static gates: `npx tsc --noEmit -p packages/backend`, `npx tsc --noEmit -p packages/contracts`, `pnpm --dir packages/backend check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict` (zero findings for discovery search code; paste exact output into `gaps.md` section C). ESLint/prettier are blocked in this sandbox — say so in the report.
- [ ] T112 Whole capability suite once: `../../scripts/sdd/test-spec.sh libs/domains/discovery`, then `libs/infrastructure/projections/versioned-sinks` and the fulfilment pickup spec; record the green run (VII.9).
- [ ] T113 Final report: list every follow-up from built specs and how it was handled (S03 closed-shop retest in T090 and tenancy services in T093; S05 in T046–T063/T107; S49 in T037/T077; S50 in T036; S53 in T049/T018), and the Complexity Tracking row (catalog `embedding`/`searchVector` columns stay until S05's contract step).

---

## Dependencies

- Phase 1 → Phase 2 (T004 before T005–T010; T011–T014 before T015; T016 before T017–T019; T020 before adapters; each unit spec T021–T026 before its implementation T027–T032).
- Phase 2 → everything. US4 before US1 (search tests need projected documents). US1 before US2/US3 (same service and adapter). US5 needs US4 and US1. US6 needs US1. US7 needs US4's shop-table writes. US8 needs US1 (`searchId`). US9 needs US1 and US8. Polish last.
- `search-admin.controller.ts` is shared by US5, US6, US8: do T081 → T088 → T099 in that order.

## Parallel examples

- Phase 2: T006–T009 (separate migrations); T011–T014 (separate contract files); T021–T026 (six unit specs), then T028–T032.
- After US1: US7 (T090–T094) in parallel with US8 click service (T097); T106 (web) once T061 lands.

## Implementation strategy

MVP = Phase 1 + Phase 2 + US4 + US1 (events feed the index, buyers search with visibility, boosts, paging, rate limit, degradation). Then US5 (reindex, P1) before the P2 stories (US2, US3, US6, US7), then US8, US9, polish. Each phase ends with its narrowest test green; the whole discovery suite runs once at T112.
