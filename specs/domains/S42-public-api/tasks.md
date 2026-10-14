# Tasks: S42 — Seller public API (domain `developer-platform`)

**Input**: [plan.md](plan.md), [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted), [data-model.md](data-model.md), [research.md](research.md), [contracts/http.md](contracts/http.md), [contracts/events.md](contracts/events.md), [contracts/services.md](contracts/services.md), [quickstart.md](quickstart.md). Constitution v3.1.0.

**Tests**: required (test-plan.md has one row per AS-nn). Inside every story the failing test task comes **before** the code task that makes it pass. Run a single e2e file with `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>` from `packages/backend`; after 5 failed fixes of the same test stop and write the blocker into `questions.md`.

**Format**: `- [ ] T### [P?] [US?] Description with path`. `D` = `packages/backend/libs/domains/developer-platform`; `C` = `packages/contracts/src/developer-platform`. Cross-spec rules: living spec first (rule 0, never touch `*.reviewed.json`); no edits to sibling specs, only bullets under "Sibling-spec follow-ups" in `gaps.md` (rule 1); unproven SC-nnn only in quickstart "Ops artifacts" + `specs/UNVERIFIED.md` (rule 2); no git checkout/restore/reset/stash/clean (rule 3); `TransactionRunner.run` / `@Transactional` only, no new `sequelize.transaction` (rule 4).

**Lessons applied**: L-001/L-002 queue option validated at producer + queue in `elasticmq.conf` + readiness; L-003 no "A or B" assertions; L-004/L-015/L-018 four wiring specs and built-binary start; L-005/L-006 each test creates its own data; L-007 runner timeouts; L-008 batches of fresh processes; L-010 sandbox first-use idempotent; L-013 faults restored in `afterEach`; L-016 repair helpers survive the failure they report; L-017 scenario mapping of the old e2e file; L-019 runtime proofs by script at the final checkpoint.

## Phase 1: Setup

- [X] T001 WP-0 Create the living-spec page `docs/spec/capabilities/S42-public-api.md` (rules and behaviors first: pinned versions, structured `RateLimit`/`RateLimit-Policy` headers instead of FR-051's legacy names, deprecation, bulk delta, required `Idempotency-Key`, three jobs) with `[proof: …]`/`[code: …]` anchors filled as tests land; run `python3 scripts/livespec/check.py`; never create or edit `*.reviewed.json`; record any signed-rule change under "## Spec changes" in `gaps.md`
- [X] T002 [P] Build the e2e kit `D/testing/public-api-kit.ts`: boot helpers for `PublicApiModule`, `DevelopersModule`, `PublicApiWorkerModule`, `PublicApiProjectorModule` with production prefix/pipes/filter; frozen clock `2026-10-06T12:00:00Z` with advance; shop/user/session seeding only through identity `SessionIssuer` and tenancy exported services; products/orders through catalog/orders exported services; switchable fault wrappers at the edge (Redis fast store, event producer, limiter store, quota port, queue) restored in `afterEach`; `waitFor(condition)` (no fixed sleeps)
- [X] T003 [P] Create contracts scaffolding `C/index.ts` and folders for per-version schemas (`C/v2026-01-15/`, `C/v2026-10-01/`, `C/keys.ts`, `C/logs.ts`, `C/usage.ts`, `C/problem.ts`, `C/events.ts`) exported from `packages/contracts/src/index.ts`
- [X] T004 [P] Add config `api_key_pepper` (required, startup fails without it) and `api_key_pepper_previous` (optional) to `packages/backend/libs/common/config/api-config.service.ts` and its S54 validation schema; add both to the test environment (G-01)

---

## Phase 2: Foundational (blocks every story)

**Purpose**: pure rules, typed errors, ports, migrations, ownership, queue, shared additions. Unit specs are written first and must fail.

- [X] T005 [P] Write failing table-driven spec `D/domain/key-status.spec.ts` (derived-status order revoked → expired → rotating → active with injected `now`; allowed transitions `active→rotating`, `active|rotating→revoked`, time-only `→expired`; illegal ones named `key_revoked|key_expired|key_already_rotating`; `assertNever`)
- [X] T006 [P] Write failing spec `D/domain/versioning.spec.ts` (resolution order header → pin → latest, echo, invalid `400 invalid_version`, every change × resource up/down transformer, registry validation: order, latest not retired, downgrade completeness) plus `fast-check` upgrade∘downgrade round trip
- [X] T007 [P] Write failing spec `D/domain/deprecation.spec.ts` (header values `Deprecation`, `Sunset` as IMF-fixdate in UTC, `Link rel="deprecation"` with `type="text/html"`, window evaluation: before/at/after sunset and brownouts, registry rule "sunset ≥ 6 months after deprecation", version `2026-01-15` deprecated 2026-10-01 sunset 2027-04-01)
- [X] T008 [P] Write failing spec `D/domain/sparse-fields.spec.ts` (`fields` and `expand` parse table in requested-version names; `expand` only `shop`, ≤ 3 values, depth 1; unknown → `invalid_fields|invalid_expand`)
- [X] T009 [P] Write failing spec `D/domain/bulk-chunking.spec.ts` (split 101…10,000 items into chunks of 100, `chunks = ceil(total/100)`, status rules `processing` while `completedChunks < chunks`, then `succeeded` (failed = 0) / `failed` (applied + replayed = 0) / `partially_failed`; `failed` counts outcomes not `applied|replayed`; idempotent chunk accounting)
- [X] T010 [P] Write failing spec `D/domain/usage-bucket.spec.ts` (UTC-minute bucket, billable rule excludes sandbox/401/etc. per spec FR-058, deterministic event id per `(shop, metric, minute, sequence)`) plus `fast-check` property: sum of buckets = number of billable records under any duplication and ordering
- [X] T011 [P] Extend failing `D/domain/api-key-format.spec.ts` (prefix collision regenerate ≤ 5, parse, constant-time compare, hash with current/previous pepper and `hashVersion` 1/0) — AS-20
- [X] T012 [P] Write failing table-driven spec `D/domain/batch-plan.spec.ts` for `D/domain/batch-plan.ts` (batchable set: not `/v1/batch`, not `/v1/stock/bulk` over 100 items, `GET /v1/stock/bulk/:jobId` allowed; 1–50 operations; cost = operation count; 10 s budget with injected clock)
- [X] T013 [P] Implement `D/domain/key-status.ts` (G-02, makes T005 pass)
- [X] T014 [P] Implement the one registry with lifecycle and request upgraders / response downgraders in `D/domain/version-registry.ts` and `D/domain/versioning.ts` (replaces separate `API_VERSIONS`/`VERSION_CHANGES`; startup validation; string compare on ISO dates tested) (G-16, G-17; makes T006 pass)
- [X] T015 [P] Implement `D/domain/deprecation.ts` (routes and versions, sunset, brownouts, `410 endpoint_retired|version_retired|endpoint_brownout` + `Retry-After`, injected clock) (G-17, G-18; makes T007 pass)
- [X] T016 [P] Implement `D/domain/sparse-fields.ts` (G-25; makes T008 pass)
- [X] T017 [P] Implement `D/domain/bulk-chunking.ts` (makes T009 pass)
- [X] T018 [P] Implement `D/domain/usage-bucket.ts` (makes T010 pass)
- [X] T019 [P] Extend `D/domain/api-key-format.ts` (collision retry, parse, constant-time compare, peppers, `hashVersion`) (G-01, G-12; makes T011 pass)
- [X] T020 [P] Implement `D/domain/batch-plan.ts` (makes T012 pass)
- [X] T021 Create typed `ApiError` subclasses with catalogue codes in `D/domain/errors.ts` (codes exactly as in `contracts/http.md`: `invalid_api_key`, `insufficient_scope`, `mfa_required`, `key_limit_reached`, `key_revoked`, `key_expired`, `key_already_rotating`, `idempotency_key_required`, `invalid_cursor`, `invalid_expand`, `invalid_version`, `quota_exceeded`, `rate_limit_cost_exceeded`, `rate_limiter_unavailable`, `service_unavailable`, `batch_deadline_exceeded`, `unsupported_operation`, `version_conflict`, `product_archived`, `endpoint_retired`, `version_retired`, `endpoint_brownout`, …) and the S54 filter mapping to problem+json (G-37)
- [X] T022 Create ports in `D/domain/ports.ts`: `ApiKeyRepository`, `SettingsRepository`, `BulkJobRepository`, `UsageBucketRepository`, `KeyCache`, `RequestLogStore`, `QuotaPort`, `ShopDirectory`, `CatalogGateway`, `OrderGateway`, `Clock` (CLOCK token) — controllers/services depend on ports only (G-45, D-6)
- [X] T023 Write the three migrations in `packages/backend/migrations/` (timestamps after the latest existing one; each statement under `lock_timeout = '3s'`; idempotent `IF [NOT] EXISTS`; with `down`): (1) expand — `ApiKey.successorId` uuid null, `rotatedAt` timestamptz null, `hashVersion` smallint default 1; `ShopApiSettings.pinnedAt` timestamptz null backfilled from `updatedAt`; create `ApiBulkJob` (`id` varchar(36) PK `bsu_`+32 hex, `shopId` uuid not null, `total` 101–10,000, `chunks`, `completedChunks/applied/replayed/failed` int default 0, `failures` jsonb default `[]` first 1,000, `status` processing|succeeded|partially_failed|failed, `createdAt`, `expiresAt = createdAt + 7 d`; indexes `(shopId, id)`, `(expiresAt)`), `ApiBulkChunk` (`(jobId, index)` PK, `shopId`, `state` pending|done|failed, `result` jsonb null, `completedAt`), `ApiUsageBucket` (`(shopId, minute, sequence)` PK, `quantity` int ≥ 1, `emittedAt` null, `eventId` uuid null; partial index `(emittedAt) WHERE emittedAt IS NULL`); `ApiKey` indexes unique `(prefix)`, `(shopId, createdAt DESC, id)`, partial `(shopId) WHERE revokedAt IS NULL`; ClickHouse additive columns `clientRequestId`, `errorCode`, `batchOps`, `idempotentReplay`, `deprecated` on `api_requests` via the repo's ClickHouse migration mechanism; (2) contract — drop FKs `ApiKey.shopId→Shop`, `ApiKey.createdBy→User`, `ShopApiSettings.shopId→Shop` (names read from catalog, `IF EXISTS`), do not touch `Shop.sandboxOf` (S03's); (3) registry — see T024 (G-42, G-26, G-35)
- [X] T024 Register `ApiBulkJob`, `ApiBulkChunk`, `ApiUsageBucket` (owner `domain:developer-platform`) in `packages/backend/db/ownership.ts`; model files in `D/infra/`; run `pnpm check:model-registry` (G-42)
- [X] T025 [P] Add queue `public-api-bulk-chunk` + DLQ to `infra/docker/elasticmq.conf` and `infra/stack/main.tf`; make readiness fail while the consumed queue is missing (L-002)
- [X] T026 [P] Write failing test in `packages/backend/libs/infrastructure/idempotency/` for new `IdempotentOptions.required` (`422 idempotency_key_required`) and `IdempotentOptions.scope(req)`; then implement them additively, existing routes unchanged; re-run the module's own e2e and the order-checkout suite (G-30, S53/S54 follow-up)
- [X] T027 [P] Write failing test in the orders suite for `OrderQueryService.getShopOrder(shopId, shopOrderId): Promise<ShopOrderDto | null>` (one shop-scoped statement; `null` for another shop's order), then implement it in `packages/backend/libs/domains/orders/application/order-query.service.ts` (sibling follow-up S10, III.4)
- [X] T028 [P] Move policies into `D/rate-limit-policies.ts` with `definePolicies` + `forFeature`: `public-api.default` with per-request cost and `public-api.auth-failure.ip` (30/min, fail closed); ask S50 contract for cost headers in `gaps.md` only if missing (S50 follow-up, G-31)
- [X] T029 Create the shared request-context middleware `D/api/request-context.middleware.ts` skeleton: server-generated `Request-Id`, echo valid client value as `X-Client-Request-Id`, `Cache-Control: no-store`, headers set once in one function (R-07, G-33)
- [X] T030 Split modules so each app boots alone: `D/developers.module.ts`, `D/public-api.module.ts`, `D/public-api-worker.module.ts`, new `D/public-api-projector.module.ts`, each with explicit imports (tenancy, catalog, orders, billing, identity, rate-limit, idempotency, outbox, cache); update `D/index.ts` to export modules and `ApiVersionService` only, removing `ApiRequestsProjector`, `WebhookRouterProjector`, `WebhookDeliverer` and other internals (webhook exports of S43 untouched); update the apps to import modules (G-41, D-8)
- [X] T031 Write the per-version zod schemas in `C/` for products, orders, lists, batch results, bulk jobs, key DTOs, log rows, usage rows, problem document, error-code enum equal to `contracts/http.md`, and event schemas for `developer_platform.api_key_created|rotated|revoked`, `developer_platform.api_version_pinned`, `api.request_logged` (additive fields, version stays 1), consumed `tenancy.shop_deleted|shop_status_changed` (G-39)

**Checkpoint**: unit specs green (`pnpm run test libs/domains/developer-platform/domain`), migrations apply on a fresh DB, `tsc` clean.

---

## Phase 3: User Story 1 — A shop manager issues and controls API keys (P1) 🎯 MVP

**Goal**: create, list, rotate, revoke keys safely (AS-01…AS-12). **Independent test**: `api-keys.e2e-spec.ts` + the AS-12 part of the consumers file.

### Tests (write first, must fail)

- [X] T032 [P] [US1] `D/api-keys.e2e-spec.ts` describe "Developer platform: API key lifecycle (dashboard)": AS-01 (secret shown once, only hash stored, `hashVersion`, outbox event `api_key_created`, no secret in event), AS-02 (validation classes: `name` trimmed 1–60, `scopes` 1–4 distinct from the four, `expiresAt` future ≤ 365 d, `overlapHours` integer 0…168, `forbidNonWhitelisted`), AS-03 (who may manage; foreign key IDs → 404)
- [X] T033 [P] [US1] Same file: AS-04 (sensitive routes; live create/rotate without `amr` ∋ `mfa` → `403 mfa_required`; revoke never blocked), AS-05 (25 active-or-rotating keys limit, 20 parallel creators, repeated ≥ 20×, `422 key_limit_reached`)
- [X] T034 [P] [US1] Same file: AS-06 (rotate with overlap, `successorId`, status `rotating`, `previousExpiresAt` from stored value), AS-07 (revoked/expired/rotating rotate → 409 codes; concurrent rotate one winner, ≥ 20×), AS-08 (revoke immediate, idempotent `204`, one event), AS-09 (revoke races a cache fill, tombstone, ≥ 20×)
- [X] T035 [P] [US1] Same file: AS-10 (expiry at the boundary with injected clock), AS-11 (`lastUsedAt` write-behind, monotonic, restore on flush failure)
- [X] T036 [P] [US1] `D/developer-platform-consumers.e2e-spec.ts` describe "Developer platform: consumers …": AS-12 shop-lifecycle consumer (shop deleted revokes keys once; duplicate delivery; invalid payload → DLQ) delivered through the S53 consumer entry point with schema-valid envelopes

### Implementation

- [X] T037 [US1] Implement repositories `D/infra/sequelize-api-key.repository.ts` and `D/infra/sequelize-settings.repository.ts` (conditional statements, shop in every predicate, create under per-shop row lock on `ShopApiSettings` with `FOR UPDATE` + count + insert + outbox in one `TransactionRunner.run`; prefix collision regenerate) (G-06, G-12)
- [X] T038 [US1] Implement `D/infra/redis-key-cache.ts` (one `MGET` for entry + tombstone, fill-if-absent, short revoke tombstone, `lastUsedAt` atomic drain with parameterised arrays and injected clock) (G-03, G-09)
- [X] T039 [US1] Implement `D/application/api-keys.service.ts` (create with limit, conditional rotate: `UPDATE … WHERE id AND shopId AND revokedAt IS NULL AND successorId IS NULL AND (expiresAt IS NULL OR expiresAt > now)` asserting one row; idempotent revoke; list with derived `status` from `key-status`; events in the same transaction; no `Date.now()`) (G-02, G-03, G-08, G-10)
- [X] T040 [US1] Implement `D/application/key-usage.flusher.ts` job `public-api.flush-key-usage` on the injected clock in `D/infra/jobs.ts` (G-09)
- [X] T041 [US1] Rewrite `D/api/api-keys.controller.ts`: one application service, no Sequelize/ClickHouse/Cache injection; `Firewall({ sensitive: true })` on create, rotate, revoke, pin (no `SessionNotRevokedGuard`); `amr` ∋ `mfa` for live create/rotate; DTO with `expiresAt` and `overlapHours` (G-07, G-08, G-45, S01 follow-up)
- [X] T042 [US1] Implement `D/application/shop-lifecycle.handler.ts` + consumer registration in `D/infra/consumers.ts` (inbox, zod validation, DLQ) for `tenancy.shop_deleted` (revoke keys once) and `tenancy.shop_status_changed` (invalidate shop-status entry) (G-10)
- [X] T043 [US1] Run `api-keys.e2e-spec.ts` and the AS-12 tests until green; update `S42-public-api.md` `[proof]` anchors

**Checkpoint**: US1 independently green.

---

## Phase 4: User Story 2 — An integration authenticates, and only reaches its own shop (P1)

**Goal**: AS-13…AS-21. **Independent test**: `public-api-auth.e2e-spec.ts`.

- [X] T044 [P] [US2] `D/public-api-auth.e2e-spec.ts` describe "Public API: authentication, scopes and tenant isolation": AS-13 (one identical `401 invalid_api_key` + `WWW-Authenticate: Bearer` for missing/malformed/unknown/revoked/expired/key in query), AS-14 (failed-auth throttle `public-api.auth-failure.ip`, counter `public_api_auth_failures_total{reason}`), AS-15 (`it.each` over routes × scopes), AS-16 (cross-tenant is 404 on every route incl. foreign ids)
- [X] T045 [P] [US2] Same file: AS-17 (suspended `403 shop_suspended`, offboarding `409 shop_offboarding`, events immediate, 60 s staleness bound), AS-18 (fast store down → degrade to DB with `public_api_key_cache_degraded_total`; both down → `503 service_unavailable` + `Retry-After: 5`; forced fault restored in `afterEach`), AS-19 (secrets never in logs, events, errors, metric labels), AS-21 (boot fails without `api_key_pepper`; previous pepper re-hash on use)
- [X] T046 [US2] Implement `D/api/api-key.guard.ts` (uniform 401, dummy hash comparison for unknown prefixes, degraded modes with short timeouts, status gate from the 60 s shop-status entry via S03 `ShopQueryService`/`ShopAccessService`, re-hash on previous pepper, `actingShopId` + `liveShopId` pair in CLS) (G-04, G-05, G-11, S03 follow-up)
- [X] T047 [US2] Implement `D/api/scope.guard.ts` and `D/api/lifecycle.guard.ts` with typed errors; replace every `{type, message}` throw with typed `ApiError`s (G-37, FR-015/016)
- [X] T048 [US2] Add auth-failure counters/metrics and policy wiring `public-api.auth-failure.ip` (30/min, fail closed) to the guard path (G-04, G-31)
- [X] T049 [US2] Run `public-api-auth.e2e-spec.ts` until green

---

## Phase 5: User Story 3 — Developers test against an isolated sandbox (P1)

**Goal**: AS-22…AS-25. **Independent test**: `public-api-sandbox.e2e-spec.ts`.

- [X] T050 [P] [US3] `D/public-api-sandbox.e2e-spec.ts` describe "Public API: sandbox": AS-22 (live/sandbox isolation both ways), AS-23 (10 parallel first calls create exactly one sandbox shop, ≥ 20×; L-010 idempotent), AS-24 (no orders — fixed empty list and `404` —, no usage, no quota), AS-25 (key mode bound to key; `livemode` mismatch refused)
- [X] T051 [US3] Implement `D/infra/shop-directory.adapter.ts` calling S03 `ShopProvisioningService.ensureSandboxShop` at first use (cached with the key record) and `ShopQueryService`; delete all `Shop` SQL and `sandboxOf` handling from `api-keys.service.ts` (G-13, D-12, S03 follow-up)
- [X] T052 [US3] Add `livemode` to every resource DTO and exclude sandbox from usage and quota (G-14)
- [X] T053 [US3] Run `public-api-sandbox.e2e-spec.ts` until green; add S03 note on concurrency-safe `ensureSandboxShop` if the 10-parallel test needs it (sibling follow-up already listed)

---

## Phase 6: User Story 4 — Versions are pinned per shop and evolve by transformers (P1)

**Goal**: AS-26…AS-31. **Independent test**: `public-api-versions.e2e-spec.ts` (AS-26…AS-30) + unit specs (T006, T007).

- [X] T054 [P] [US4] `D/public-api-versions.e2e-spec.ts` describe "Public API: date-pinned versions and deprecation" — versions part: AS-26 (first key pins the shop atomically, a newly registered second version does not move it, ≥ 20×), AS-27 (resolution order and echo, invalid version `400`), AS-28 (one wired product, order, list downgraded; `2026-01-15` keeps bare-integer money), AS-29 (requests upgraded; `fields` in requested-version names), AS-30 (pin from the dashboard, `GET api-version`, `{version, previousVersion, pinnedAt}`, event, propagation within 5 s, retired version refused, ≥ 20×)
- [X] T055 [US4] Implement `D/application/api-version.service.ts` (`supportedVersions`, `latestVersion`, `isSupported`, `getPinnedVersions`; pin once at first key creation in the same transaction, unpinned shop pinned at first authenticated call; pin via repository port; event `api_version_pinned`) and `D/api/api-version.controller.ts` (`PUT`/`GET api-version`, `Firewall({ sensitive: true })`) (G-15, G-20)
- [X] T056 [US4] Implement `D/api/public-api.interceptor.ts` for version resolve, request upgrade, response downgrade; evaluate `fields`/`expand` after downgrade; remove its `Sequelize` injection (G-16, G-45)
- [X] T057 [US4] Run the versions tests of T054 until green

---

## Phase 7: User Story 5 — Deprecations are announced, measured and enforced (P2)

**Goal**: AS-32…AS-36. **Independent test**: remainder of `public-api-versions.e2e-spec.ts`, `public-api-contract.e2e-spec.ts` (AS-36), `public-api-logs-usage.e2e-spec.ts` (AS-35).

- [X] T058 [P] [US5] In `D/public-api-versions.e2e-spec.ts`: AS-32 (deprecated route headers, also on error responses), AS-33 (deprecated version headers), AS-34 (sunset `410`, brownout window with `Retry-After`; injected clock)
- [X] T059 [P] [US5] In `D/public-api-logs-usage.e2e-spec.ts` (describe "Public API: request logs and usage report"): AS-35 deprecation telemetry per key (`public_api_deprecated_calls_total`, usage report rows with `lastCallAt`, `deprecated` filter)
- [X] T060 [P] [US5] In `D/public-api-contract.e2e-spec.ts` (describe "Public API: problem details, OpenAPI, contracts and transport defaults"): AS-36 registry vs OpenAPI, additive-only changes
- [X] T061 [US5] Wire registry-driven deprecation headers (computed from the injected clock) and `410`/brownout handling in the request-context middleware, on every response including errors (G-18, G-19, G-43)
- [X] T062 [US5] Run T058–T060 tests until green

---

## Phase 8: User Story 6 — Products, stock and orders readable and writable safely (P1)

**Goal**: AS-37…AS-42. **Independent test**: `public-api-resources.e2e-spec.ts`.

- [X] T063 [P] [US6] `D/public-api-resources.e2e-spec.ts` describe "Public API: products, stock and orders": AS-37 (strict `limit` 1…100 default 20, opaque signed cursor `400 invalid_cursor`, stable order), AS-38 (`fields`/`expand`, one `getShopsByIds` call), AS-39 (create: `price` `{amount: int 1…max, currency}`, `0`/negative/fractional/other currency refused, `brand` 1…100 required at latest, `2026-01-15` upgrader sends `Unbranded`, title ≤ 200)
- [X] T064 [P] [US6] Same file: AS-40 (`PATCH` with `If-Match`: `428` absent, `412 version_conflict` stale, `ETag`/`version`, `409 product_archived`, concurrent patch ≥ 20×), AS-41 (stock read and deprecated route, camelCase), AS-42 (orders: the shop's slice, no buyer data, money objects, `getShopOrder`, `…Minor` mapping)
- [X] T065 [P] [US6] Rewrite the old `D/public-api.e2e-spec.ts` scenarios into this file per the mapping in T094 (L-017): no `Shop` model injection, no `ShopApiSettings` inserts, no mocked Kafka producer
- [X] T066 [US6] Implement `D/infra/catalog.gateway.ts` and `D/application/public-catalog.service.ts` on S05 `ProductQueryService`, `ProductCommandService` (`create`, `update` with `expectedVersion`, `listByShop`, `getForShop`) and `ProductStockService.applyStockDelta`; map DTOs from the member view (`priceMinor`, `currency`, `status`); delete every `Product`/`Shop` query and product outbox call; no legacy `ProductService` (G-21–G-25, G-29, D-12, S05 follow-ups)
- [X] T067 [US6] Implement `D/infra/order.gateway.ts` and `D/application/public-orders.service.ts` on S10 `OrderQueryService.getOrdersForShop`, `getOrderLines`, `getShopOrder` (money fields `…Minor` → money objects; no buyer data; sandbox empty/404) (G-27, S10 follow-up)
- [X] T068 [US6] Rewrite `D/api/v1.controller.ts`: strict pagination pipes, `fields`/`expand` allowlist, `If-Match`/`ETag`, id format validation (`^bsu_[0-9a-f]{32}$` for job ids), problem details for `405`/`404` (G-22, G-24, G-25, G-29)
- [X] T069 [US6] Run `public-api-resources.e2e-spec.ts` until green

---

## Phase 9: User Story 7 — Batch and bulk stock for ERP-sized work (P2)

**Goal**: AS-43…AS-52 (AS-48 asserted in US8). **Independent test**: `public-api-batch.e2e-spec.ts`.

- [X] T070 [P] [US7] `D/public-api-batch.e2e-spec.ts` describe "Public API: batch and bulk stock": AS-43 (happy path), AS-44 (1–50 operations, unsupported → `422 unsupported_operation`, `/v1/batch` itself not batchable), AS-45 (per-operation `403 insufficient_scope`, tenant miss `404`), AS-46 (failure isolation, not one transaction), AS-47 (batch and per-operation idempotency keys), AS-49 (10 s budget, later operations `503 batch_deadline_exceeded`; forced-fault test)
- [X] T071 [P] [US7] Same file: AS-50 (synchronous bulk ≤ 100 items, delta `{operationId, productId, delta}`, `operationId` 1–128 unique, `delta` non-zero int with `|delta| ≤ 1,000,000`, never below zero), AS-51 (bulk job: duplicate chunk delivery, invalid chunk payload → DLQ, crash/redelivery double-counts nothing), AS-52 (10,000-item file with unknown products, replay-safe)
- [X] T072 [US7] Implement `D/application/batch.service.ts` and `D/api/batch.controller.ts`: validate each operation with the schema of its route, per-operation status and problem body, `ifMatch`, budget by injected clock, operation idempotency keys, version transform of results (G-28)
- [X] T073 [US7] Implement `D/infra/sequelize-bulk-job.repository.ts`, `D/application/bulk-stock.service.ts`, `D/api/bulk-stock.controller.ts` (≤ 10,000 items; one shop-scoped pre-lookup; durable `ApiBulkJob`/`ApiBulkChunk`; producer validates queue options where the message is created, no `groupId` on a standard queue — L-001) (G-26)
- [X] T074 [US7] Implement `D/application/bulk-chunk.worker.ts` (schema-validated, per-chunk marker flips first, then `applyStockDelta` idempotent per `operationId`, then counters in the same marker transaction via `TransactionRunner.run`; DLQ; `partially_failed`) and `D/application/bulk.purger.ts` job `public-api.purge-bulk-jobs` (≤ 500 rows per statement, 7-day retention) in `D/infra/jobs.ts`, `D/infra/consumers.ts`
- [X] T075 [US7] Run `public-api-batch.e2e-spec.ts` until green

---

## Phase 10: User Story 8 — Fair use: idempotency, rate limits and plan quotas (P1)

**Goal**: AS-48, AS-53…AS-57. **Independent test**: `public-api-limits.e2e-spec.ts`.

- [X] T076 [P] [US8] `D/public-api-limits.e2e-spec.ts` describe "Public API: idempotency, rate limits and quotas": AS-48 (batch cost = operation count, bulk cost = ⌈items ÷ 100⌉, `422 rate_limit_cost_exceeded`), AS-53 (required `Idempotency-Key` 1–255 on `POST /v1/products`, `/v1/stock/bulk`, `/v1/batch`: replay, in flight 409, different body 422, TTL, missing `422 idempotency_key_required`; scope = acting shop + route), AS-54 (concurrent identical requests, ≥ 20×)
- [X] T077 [P] [US8] Same file: AS-55 (per-key limit, structured `RateLimit` and `RateLimit-Policy` headers only — no `RateLimit-Limit`/`X-RateLimit-*`, `Retry-After`), AS-56 (limiter store down fails open, counter; forced fault), AS-57 (monthly quota `429 quota_exceeded` with `Retry-After` ≤ 3,600 s, 60 s cache, `usage_unavailable` fails open with `public_api_quota_degraded_total`, sandbox exempt; fake `QuotaPort`; forced fault)
- [X] T078 [US8] Apply the shared idempotency options (`required`, `scope`) on the three creating POSTs and per batch operation (G-30)
- [X] T079 [US8] Per-request rate-limit cost and headers on every response; `503 rate_limiter_unavailable` mapping in contract (G-31, S50 follow-up)
- [X] T080 [US8] Implement `D/infra/billing-quota.adapter.ts` (`QuotaPort`; allows and counts `public_api_quota_degraded_total{reason="not_available"}` until S18 exports `checkQuota`) and the quota gate with 60 s cache (G-32)
- [X] T081 [US8] Run `public-api-limits.e2e-spec.ts` until green

---

## Phase 11: User Story 9 — Request logs, usage and exact billing events (P1)

**Goal**: AS-58…AS-64. **Independent test**: `public-api-logs-usage.e2e-spec.ts` and the consumers file.

- [X] T082 [P] [US9] In `D/public-api-logs-usage.e2e-spec.ts`: AS-58 (one request record per authenticated call incl. 401/403 from guards where the spec says so, built from the final response, `clientRequestId`, `errorCode`, `batchOps`, `idempotentReplay`), AS-59 (server-generated request IDs), AS-60 (search with filters `status` class, `route`, `keyId`, `livemode`, `from/to`, keyset cursor, `limit 1…100`; cross-tenant isolation), AS-61 (event bus down: request unaffected, bounded buffer 10,000, counted drops; forced fault), AS-63 (usage report `days`, `livemode`, `deprecated`, per-key rows)
- [X] T083 [P] [US9] In `D/developer-platform-consumers.e2e-spec.ts`: AS-62 (request-log projector: duplicate delivery inserts one row, invalid payload → DLQ), AS-64 (`usage.recorded` exact: duplicate, late record emits new sequence, invalid payload; sandbox excluded)
- [X] T084 [US9] Implement `D/infra/request-record.sink.ts` (bounded retry buffer, counted drops, shutdown flush) and the record built after the final status (response interceptor + filter hook); event fields per `contracts/events.md` in `D/application/events/api-events.ts` (G-33, G-43)
- [X] T085 [US9] Implement `D/infra/clickhouse-request-log.store.ts`, `D/application/request-log.service.ts`, `D/application/usage-report.service.ts`, `D/api/logs-usage.controller.ts` (no SQL in controller) (G-34, G-36, G-19)
- [X] T086 [US9] Update `D/infra/api-requests.projector.ts` (dedupe by `(shopId, requestId)`, payload validation, DLQ; `ReplacingMergeTree` key as second defence) registered in `PublicApiProjectorModule` (G-34)
- [X] T087 [US9] Implement `D/application/usage-metering.handler.ts` and `D/application/usage.closer.ts` (job `public-api.close-usage-minutes`, ≤ 500 buckets per batch, deterministic event ids, outbox `usage.recorded` v1 `{metric: "api.calls", quantity ≥ 1, ts}`) (G-35, G-43)
- [X] T088 [US9] Run `public-api-logs-usage.e2e-spec.ts` and the consumers file until green

---

## Phase 12: User Story 10 — Every response is predictable, documented and safe (P2)

**Goal**: AS-65…AS-71. **Independent test**: `public-api-contract.e2e-spec.ts` + static gates.

- [X] T089 [P] [US10] In `D/public-api-contract.e2e-spec.ts`: AS-65 (problem+json for every error class: `type`, `title`, `status`, `detail`, `instance`, `requestId`, `code`, `errors[]`; generic 5xx), AS-66 (2 MiB body limit, media types, `Accept`, `405`/`404` problems), AS-67 (OpenAPI 3.1 from code at `/v1/openapi.json` and `GET /api/developers/openapi.json`; each sample parses with each supported version's schema), AS-68 (OWASP doc: every referenced scenario ID exists in spec.md), AS-69 (no CORS, `no-store`, `OPTIONS` not served, `HEAD` = `GET`), AS-71 (graceful shutdown flushes records and usage minute; readiness)
- [X] T090 [US10] Implement body limits, media types, `Accept`, `405`/`404` problems, no CORS in the public-api app settings (`apps/public-api`) and `D/api/openapi.controller.ts` with both routes (G-38, G-39, W07 follow-up)
- [X] T091 [US10] Publish `docs/security/owasp-api-top-10.md` with scenario IDs (G-40)
- [X] T092 [US10] Add shutdown hooks (record buffer and usage minute flush) (G-43)
- [X] T093 [US10] AS-70 gate: run `pnpm --dir packages/backend check:table-ownership --strict` first to reconcile `gaps.md` §3 with real output, then until S42 lines are 0 (`.ownership.baseline` keeps webhook/widget lines only); `pnpm check:boundaries`, `check:module-graph`

---

## Phase 13: Polish, wiring and final checkpoint

- [X] T094 L-017 mapping, then delete `D/public-api.e2e-spec.ts`: list each of its six tests with the new file — (1) tenant by key with revoke → AS-16/AS-13 in `public-api-auth.e2e-spec.ts` + AS-08; (2) scopes → AS-15; (3) date versions → AS-28; (4) deprecated route headers → AS-32; (5) idempotency → AS-53; (6) sandbox → AS-22; bulk stock and cursor → AS-37/AS-50 — write the mapping into `quickstart.md` "Implementation notes", delete the file only when every target test is green
- [X] T095 [P] Wiring spec `apps/public-api/src/public-api-wiring.e2e-spec.ts`: boots alone, maps all `/v1` routes (mapped route without key → `401` problem+json, unmapped `404`), refuses to start without `api_key_pepper`, declares both rate policies (L-015, L-018)
- [X] T096 [P] Wiring spec `apps/core/src/developers-wiring.e2e-spec.ts`: dashboard routes and `GET /api/developers/openapi.json`
- [X] T097 [P] Wiring spec `apps/worker/src/public-api-wiring.e2e-spec.ts`: three jobs `public-api.flush-key-usage`, `public-api.purge-bulk-jobs`, `public-api.close-usage-minutes` and consumer `public-api-bulk-chunk`
- [X] T098 [P] Wiring spec `apps/projector/src/public-api-wiring.e2e-spec.ts`: `public-api-request-log`, `public-api-usage-metering`, `public-api-shop-lifecycle`
- [X] T099 [P] Write k6 script `scripts/load-tests/public-api-mixed.test.js` (SC-010: 30,000 rps, 100,000 keys, mixed reads/batch/bulk); do not run it; keep UNVERIFIED rows `not run`
- [X] T100 [P] Confirm the six S42 rows in `specs/UNVERIFIED.md` and the "Ops artifacts" table in `quickstart.md` match each other and say `not run`; no criterion described as verified (rule 2)
- [X] T101 [P] Add the missing bullets under "## Sibling-spec follow-ups" in `gaps.md` if implementation found new ones (S10 `getShopOrder`, S18 `checkQuota`, S43 `ApiVersionService`/idempotency store, S44 widget reads, S03 `ensureSandboxShop`, S05 `version`/cursor, shared idempotency options, W04, S28 already listed); record any signed-rule change under "## Spec changes"
- [X] T102 Rule-4/leftover greps from `packages/backend`: `grep -rn "sequelize.transaction\|S54 T037 audit" libs/domains/developer-platform` and `grep -rnE "FROM \"(Product|Shop|ShopOrder|BisOrder|BisOrderItem)\"" libs/domains/developer-platform` both empty for S42 files; `.tx.baseline` stays 0
- [X] T103 Final checkpoint in batches of fresh processes (L-008): unit specs; each of the ten e2e files via `test-spec.sh`; sibling regressions (`libs/domains/orders/order-read`, `libs/domains/catalog/`, `libs/infrastructure/idempotency`, `webhooks.e2e-spec.ts`, `widget.e2e-spec.ts`); the four wiring specs; `tsc --noEmit`, `pnpm lint`, root `pnpm check:boundaries`, `check:module-graph`, `check:model-registry`, `check:table-ownership --strict`; `python3 scripts/livespec/check.py`; a batch without its summary line is a crash, not a flake
- [X] T104 Runtime proofs by script (L-004, L-012, L-015, L-018, L-019): `scripts/infra/boot-app.sh public-api|core|worker|projector` and `scripts/qa/fresh-run.sh`; if they cannot run here, leave the UNVERIFIED row `not run` and say so in the report
- [X] T105 Write a short ranked report (L-014): follow-ups handled (S01, S03, S05, S10, S50, S53/S54, W07, rules 0–4), blockers, UNVERIFIED rows, sibling follow-ups

---

## Dependencies & execution order

- Phase 1 → Phase 2 (blocks all) → stories. US1 first (MVP: keys are the only door). US2 needs US1's key service. US3, US4 need US1/US2. US5 needs US4 (registry) and US9 for AS-35. US6 needs US2 and T027. US7 needs US6. US8 needs US6/US7 (routes) and T026, T028. US9 needs US2 (guards) and US8 for headers. US10 last; Phase 13 after all.
- Inside each story: test task(s) → repositories/infra → services → controllers → run until green.
- Same-file edits are serialized: the files `public-api-versions.e2e-spec.ts` (T054, T058), `public-api-logs-usage.e2e-spec.ts` (T059, T082), `public-api-contract.e2e-spec.ts` (T060, T089), `developer-platform-consumers.e2e-spec.ts` (T036, T083) are shared; do not mark those tasks `[P]` against each other when run by different agents.

## Parallel examples

- Phase 2: T005–T012 (specs) together, then T013–T020 (modules) together; T025, T026, T027, T028 together.
- US1 tests T032–T036 together. US6 tests T063–T065 together. Wiring specs T095–T098 together.

## Implementation strategy

- **MVP**: Phases 1–3 (US1), then US2 for a usable, tenant-safe door. Each story ends with its own e2e file green before the next starts.
- Incremental: US3/US4 → US6 → US8 → US7 → US9 → US5 → US10 → Phase 13. Final checkpoint only once, at T103–T104.

## Gap coverage

G-01 T004, T019, T046 · G-02 T013, T039 · G-03 T038, T039 · G-04 T046, T048 · G-05 T046 · G-06 T037 · G-07 T041 · G-08 T039, T041 · G-09 T038, T040 · G-10 T039, T042 · G-11 T046 · G-12 T019, T037 · G-13 T051 · G-14 T052 · G-15 T055 · G-16 T014, T056 · G-17 T014, T015 · G-18 T015, T061 · G-19 T059, T061, T085 · G-20 T055 · G-21–G-25 T066, T068 · G-26 T073, T074 · G-27 T067 · G-28 T072 · G-29 T066, T068 · G-30 T026, T078 · G-31 T028, T048, T079 · G-32 T080 · G-33 T029, T084 · G-34 T085, T086 · G-35 T087 · G-36 T085 · G-37 T021, T047 · G-38 T090 · G-39 T031, T090 · G-40 T091 · G-41 T030 · G-42 T023, T024 · G-43 T061, T084, T087, T092 · G-44 forced-fault tests T045 (AS-18), T070 (AS-49), T077 (AS-56, AS-57), T082 (AS-61) · G-45 T022, T041, T056, T085. Debt D-12 T051/T066/T067, D-7 T002, D-6 T022, D-8 T030. Follow-ups: S01 T041, T055; S01 `SecretBox` closed (no new encrypted column); S03 T046, T051; S05 T066; S10 T027, T067; S50 T028, T077, T079; S53/S54 T026, T078; W07 T090.
