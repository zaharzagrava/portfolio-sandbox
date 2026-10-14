# Research: S42 — Seller public API

Each entry: decision, rationale, alternatives rejected. Every "NEEDS CLARIFICATION" of the Technical Context is resolved here. Facts were read from the code on 2026-10-14 (`libs/domains/developer-platform`, `libs/domains/{tenancy,catalog,orders,billing}`, `libs/infrastructure/{idempotency,rate-limit}`, `apps/public-api`). `questions.md` defaults are accepted as written (no line was edited by a human).

## Facts that change the plan (checked in code, 2026-10-14)

| Fact | Consequence |
|---|---|
| S03 `ShopProvisioningService.ensureSandboxShop(liveShopId)` and `ShopQueryService.getShopsByIds` exist | G-13, G-21, G-25 use them as written (R-12). |
| S05 `ProductCommandService` (`create`, `update`, `getForShop`, `listByShop`), `ProductStockService.applyStockDelta`, `ProductQueryService` exist; `TransactionRunner` is already used there | R1 only; delete every `Product`/`Shop` query here. |
| S10 `OrderQueryService` has `getOrdersForShop` and `getOrderLines` but **no `getShopOrder`** | R-12: added additively in S10's code, recorded as an S10 follow-up. |
| Billing has **no `checkQuota`** (S18 is not built); `UsageService.record(subject, metric, quantity, eventId)` and `totalFor` exist | R-10: a `QuotaPort` in `domain/` with a fail-open adapter; the adapter is a stub that answers "allowed" until S18 exports `checkQuota`; stated in the report and in `specs/UNVERIFIED.md`. |
| `@RateLimit(policy, { cost: (req) => n })` exists (S50); the interceptor already emits structured `RateLimit`/`RateLimit-Policy` | G-31 needs no S50 change. |
| `IdempotencyInterceptor.scopeOf` scopes by `req.apiKey?.id` (the key), not by acting shop + route (`idempotency.interceptor.ts:139`) | R-09: add an optional `scope(req)` to `IdempotentOptions` (shared infra, additive); per-batch-operation keys call the repository directly. |
| `developerPlatformRatePolicies` declares only `public-api.default`, no cost, no auth-failure policy | G-31, G-04. |
| `docs/spec/capabilities/` has no S42 page | WP-0 creates `S42-public-api.md` before behavior changes (cross-spec rule 0). |
| `.ownership.baseline` = 10 lines for the domain, `.tx.baseline` = 0 | Gate: ownership lines for S42 files → 0 (webhook/widget lines stay S43/S44's); direct `sequelize.transaction` count stays 0. |

## R-01 Layering and thin controllers (G-45, D-6, D-8)

- **Decision**: `domain/` holds pure rules and ports; `application/` one service per controller; `infra/` the adapters (Sequelize repositories, Redis key cache, ClickHouse request-log store, SQS bulk queue, Kafka/outbox publisher). `ApiKeysController` → `ApiKeysService` / `ApiVersionService` / `RequestLogService` / `UsageReportService`; `V1Controller` → `PublicCatalogService`, `PublicOrdersService`, `BatchService`, `BulkStockService`. No `@InjectConnection`, `Sequelize`, `ClickHouseService` or `CacheService` outside `infra/`. The barrel exports modules, `ApiVersionService` and DTO types only.
- **Rationale**: constitution I.1, I.2, II.1, X.4; removes D-6/D-8 for this capability.
- **Rejected**: leaving the interceptor with a `Sequelize` injection "for the pin lookup" (that is the G-20 raw SQL).

## R-02 Key store: limit, rotation, revoke are conditional statements (G-02, G-03, G-06)

- **Decision**: all in `TransactionRunner.run`. **Limit (FR-010)**: the transaction first `INSERT … ON CONFLICT DO NOTHING` the shop's `ShopApiSettings` row and `SELECT … FOR UPDATE` it (a per-shop serialisation point), then counts `status ∈ {active, rotating}` keys and inserts only if `< 25`; the concurrent creators queue on the row lock (hold = 2 statements). **Rotate**: one `UPDATE "ApiKey" SET successorId=:new, expiresAt=:stored-or-now+overlap, rotatedAt=:now WHERE id AND shopId AND revokedAt IS NULL AND successorId IS NULL AND (expiresAt IS NULL OR expiresAt > :now)` asserting 1 row (else a read-only diagnosis picks `key_revoked | key_expired | key_already_rotating`, 404 if absent for the shop), the successor insert and the outbox append in the same transaction. `previousExpiresAt` is the value written, not recomputed. **Revoke**: `UPDATE … SET revokedAt=:now WHERE id AND shopId AND revokedAt IS NULL RETURNING`; 0 rows + key exists for the shop → `204` with no event; first transition appends `api_key_revoked` in the same transaction; then tombstone (R-03).
- **Status** is the pure `domain/key-status.ts` over `{revokedAt, expiresAt, successorId}` and the injected clock, with an `assertNever` switch; the SQL predicates mirror it and a unit table plus a drift test (AS-07) keep them equal.
- **Rationale**: III.6/III.7. A counter row would add a table; the settings row already exists per shop and is created for the pin anyway (R-06).
- **Rejected**: `INSERT … SELECT … WHERE (count) < 25` (not safe at READ COMMITTED); advisory locks (invisible to the schema, harder to test).

## R-03 Verification cache, tombstone, degraded modes (G-03, G-04, G-05, G-12, G-01)

- **Decision**: cache key `apikey:v1:<prefix>` holds `{id, shopId, hashVersion, hash, scopes, livemode, expiresAt, revokedAt?, successorId?, shopStatus, status checkedAt}`, TTL 60 s (S52 `getOrLoad`, single-flight, negative entries 5 s for unknown prefixes). Revoke order: **DB commit → tombstone `apikey:revoked:<id>` (TTL 120 s) → `DEL` cache key → broadcast invalidation**. The fill is a Lua `if EXISTS tombstone then return 0 else SET NX EX 60`, and a cache hit is a single `MGET [entry, tombstone]`; a tombstone means revoked. A verification that loaded the old row before the commit therefore can neither fill after the tombstone nor serve from an entry written before it (AS-09, 20 runs). Unknown prefix: verify a dummy hash of the same cost before answering `401 invalid_api_key` + `WWW-Authenticate: Bearer`; the counter `public_api_auth_failures_total{reason}` has a closed reason set (`missing|malformed|unknown|mismatch|revoked|expired|mode|shop_inactive`). Redis failure → system of record (counter `public_api_key_cache_degraded_total`); both stores fail → `503 service_unavailable`, `Retry-After: 5` (each call has a 300 ms/1 s timeout). Prefix collision on create: regenerate up to 5 times.
- **Pepper**: `api_key_pepper` required by S54 config validation (startup fails), optional `api_key_pepper_previous`; the stored hash carries a `hashVersion`; a match with the previous pepper re-hashes in a conditional update (`WHERE hashVersion = old`), best effort.
- **Rationale**: FR-003/004/007/008/019; the tombstone is the questions.md LOCAL line.
- **Rejected**: "delete the cache only" (the original race); version counters per key (extra read on the hot path).

## R-04 Shop lifecycle (G-10, FR-013, FR-017)

- **Decision**: a consumer `public-api-shop-lifecycle` on `tenancy.events` (S53 runtime, inbox dedupe, zod from `packages/contracts`, DLQ) handling `tenancy.shop_deleted` (revoke all active keys of the shop in one statement, one `api_key_revoked{reason: shop_deleted}` event per key transitioned, tombstones) and `tenancy.shop_status_changed` (writes `shopstatus:v1:<shopId>` in Redis with the `shopVersion`, only if newer; broadcast). The guard resolves the status from that entry, filled on miss via `ShopQueryService.getShopsByIds` (60 s TTL) — staleness ≤ 60 s without events, immediate with them. `suspended → 403 shop_suspended`, `offboarding → 409 shop_offboarding`, deleted/unknown → `401` (same refusal as an unknown key, reason `shop_inactive`).
- **Rationale**: IV.3 (events, no shared table); the status is not copied into the key row.
- **Rejected**: storing status on `ApiKey` (a second source of truth that the event handler would have to update for 25 rows per shop).

## R-05 Sandbox (G-13, G-14)

- **Decision**: `ensureSandboxShop(liveShopId)` is called on the **first authenticated call of a test key**, outside the cache loader, result cached in the key entry as `actingShopId` (the live shop stays as `liveShopId`, G-11). Concurrency is S03's (AS-23 test calls the public API 10× in parallel). Every DTO has `livemode`; sandbox `/v1/orders*` answer `{object:"list", data:[], has_more:false}` / `404 resource_missing` without a service call; sandbox calls are flagged in the record (`livemode:false`), never metered and never checked against the quota.
- **Rejected**: creating the shop at key creation (a never-used test key would create shops; S03 line says on first use).

## R-06 Versions and deprecation registry (G-15…G-20)

- **Decision**: one `domain/version-registry.ts`: `VERSIONS = [{version, status: 'supported'|'deprecated'|'retired', deprecatedAt?, sunset?, replacement?, brownouts?[]}]` and `CHANGES = [{version, downgrade: {product,order,list}, upgrade: {productCreate, productUpdate}, fields: renames}]`, validated at construction (`assertRegistry`: ordered, unique, latest not retired, every change has both directions for every resource, deprecation ≥ 6 months before sunset unless `security: true` ≥ 30 days) so a bad registry fails startup (AS-31). Pinned at first key creation inside the create transaction (`INSERT ON CONFLICT DO NOTHING` on `ShopApiSettings` with `pinnedVersion = latest`; the same row is the lock of R-02); an unpinned legacy shop is pinned at its first authenticated call by the same conditional insert. `PUT api-version` → `ApiVersionService.pin(shopId, version, actorId)`: conditional upsert returning `previousVersion`, outbox event, cache `invalidate` with broadcast (≤ 5 s, AS-30). `fields`/`expand` are parsed (pure `sparse-fields.ts`) after mapping the requested version's names to latest names; the request body is upgraded by the version chain before DTO validation.
- **Headers**: computed from the registry and the injected clock by `DeprecationAnnouncer`, applied to every response of a matched route (see R-07), including problem responses. `Deprecation: @<unix seconds>`, `Sunset` as an RFC 9110 HTTP-date built from UTC midnight, `Link: <url>; rel="deprecation"; type="text/html"` and `rel="successor-version"`. After sunset a guard answers `410 endpoint_retired | version_retired` (replacement in `errors`/`detail`); inside a brownout window `410 endpoint_brownout` + `Retry-After` (seconds to the window end).
- **`ApiVersionService`** (exported, R1): `supportedVersions`, `latestVersion`, `isSupported`, `getPinnedVersions(shopIds ≤ 500)`.
- **Rejected**: header-only versioning with "latest at every call" (the BREAKING line); per-route version handlers (adding a version would change handlers, FR-026).

## R-07 One request record per authenticated call, produced from the final response (G-18, G-33, G-43)

- **Decision**: an Express middleware `RequestContextMiddleware` (module-registered in `PublicApiModule` so the standalone `apps/public-api` has it, L-018) generates `Request-Id` (uuidv7), stores the validated client `X-Request-Id` as `clientRequestId` (echo `X-Client-Request-Id`), starts the clock and wraps `res.writeHead` so that deprecation, `Marketplace-Version`, `Cache-Control: no-store`, `X-Content-Type-Options` and `Request-Id` headers are set at the moment the status is known, from `req.route?.path` and the resolved key context. On `res` `finish`, if the guard authenticated a key, it hands `{requestId, …AS-58 fields, status: res.statusCode}` to `RequestRecordBuffer`, which publishes `api.request_logged` through the outbox-free producer path (Kafka with timeout) with a bounded buffer (10,000) and retry; overflow is dropped and counted (`public_api_request_records_dropped_total`). `shutdown` hook drains the buffer and the open usage minute (AS-71). The event id is derived from the `requestId` (UUIDv5-style), so the projector and the metering consumer dedupe on the inbox and the log insert token without a second key.
- **Rationale**: guard failures after authentication (403 scope, 410, 429, pipe 400/413/415) all pass through `finish`, which an interceptor never sees; AS-58 says status "actually sent".
- **Rejected**: interceptor + filter pair (misses pipes before the interceptor and body-parser failures); writing to the outbox in the request path (cost on 30k rps; the spec asks best-effort logs).

## R-08 Request-log store and usage metering (G-34, G-35, G-36)

- **Decision**: `ApiRequestsProjector` validates the payload (zod from contracts), inserts into ClickHouse with `insert_deduplication_token = requestId` (and a `ReplacingMergeTree` keyed by `(shopId, requestId)` as second defence); invalid payload → DLQ, no row. `RequestLogService` over a `RequestLogStore` port: keyset on `(ts DESC, requestId)`, filters `requestId`, status class (`2xx|3xx|4xx|5xx` or exact), `route`, `keyId`, `livemode`, `from`/`to` within 30 days, `limit 1…100`. The usage view gains `deprecatedCalls` and per-key rows.
- **Metering**: consumer `public-api-usage-metering` (inbox dedupe by event id) adds `cost`/1 to `ApiUsageBucket(shopId, minute, sequence)` when the record is billable (live, status < 500, ≠ 429; a batch counts `batchOps`; idempotent replay counts 1). A job `public-api.close-usage-minutes` (every minute, single run; **added by this plan** — spec lists two jobs, this is the third and is recorded in `gaps.md` "Plan additions") closes buckets older than 5 s past the minute: appends `usage.recorded` (`eventId` = UUIDv5 of `shop|api.calls|minute|sequence`) through the outbox in the same transaction that marks the bucket emitted. A record arriving for an emitted minute opens `sequence + 1` (never a re-sent total). Sandbox records are skipped.
- **Rejected**: emitting from the request path (adds latency and loses on crash); deriving billing from ClickHouse sums (eventual, not exact, no stable identity).

## R-09 Idempotency, rate limits, quota (G-30…G-32)

- **Decision**: `@Idempotent({ required: true, scope: (req) => 'shop:<actingShopId>:<METHOD> <routeTemplate>' })` on the three creating POSTs. This is an additive change to `libs/infrastructure/idempotency` (`required` → `422 idempotency_key_required`; optional `scope`); its own e2e keeps passing. Batch operations use `IdempotencyRepository` directly with scope `shop:<id>:batch-op:<METHOD> <route>` and the operation's `idempotencyKey`. Rate limit: `@RateLimit('public-api.default', { cost })` with `cost` = 1, batch `operations.length`, bulk `ceil(items/100)` (validated body is read before the limiter charges: the cost function reads `req.body` after parsing; a malformed body costs 1); new policy `public-api.auth-failure.ip` (30/60 s, key `ip`, fail closed) charged by the guard on every failed authentication. Quota: `QuotaGate` (cached 60 s via S52, fail open, counter `public_api_quota_degraded_total`) → `429 quota_exceeded`, `Retry-After ≤ 3600`; live keys only.
- **Rejected**: charging the batch once per operation in a loop (N store calls); reading the quota on every call (billing store on the hot path).

## R-10 Quota adapter until S18 exists

- **Decision**: `QuotaPort.check(shopId): Promise<{allowed, resetsAt?}>`; adapter `BillingQuotaAdapter` calls S18's `checkQuota` once exported. Today it resolves `{allowed: true}` and increments `public_api_quota_degraded_total{reason="not_available"}`. AS-57 is proven with a fake port at the system edge (forced fault: `usage_unavailable` → allowed + counter; refusal → `429`). This is stated in the report; SC-level "monthly quota refuses" with the real billing store goes to `specs/UNVERIFIED.md` as `not run`.
- **Rejected**: computing the quota from `UsageService.totalFor` and plan entitlements here (duplicates S18's rule; wrong owner).

## R-11 Bulk jobs (G-26)

- **Decision**: tables `ApiBulkJob` and `ApiBulkChunk` (data-model.md). `POST /v1/stock/bulk`: ≤ 100 items → one `applyStockDelta` call after one `getProductsByIds(ids, {shopId})` pre-lookup (foreign/missing → per-item `not_found`, rest applied; if any item is not found the batch is still all-or-nothing for the found ones as S05 defines); > 100 → job row + chunk rows + queue messages (`public-api-bulk-chunk`, standard queue, no FIFO options — L-001; queue and DLQ added to `elasticmq.conf`, L-002) in one transaction via the S53 queue port; `202` + `Location`. The chunk worker (in `PublicApiWorkerModule`) validates the message with zod, then in one transaction: `UPDATE "ApiBulkChunk" SET state='done', result=… WHERE jobId AND index AND state <> 'done'` (1 row → apply stock, then update counters from the stored result; 0 rows → replay: counters untouched). Stock application is idempotent per `operationId` in S05, so a crash after apply and before the marker replays as `replayed`. Status derives from chunk states (`processing|succeeded|partially_failed|failed`). `public-api.purge-bulk-jobs` (daily) deletes rows older than 7 days in batches.
- **Rejected**: Redis hash (the BREAKING line); one message per item (queue cost).

## R-12 Sibling services this plan consumes or asks for

- S03 `ensureSandboxShop`, `getShopsByIds`, `ShopAccessService` (via `ShopScoped`): used as they exist. `sandboxOf` and its index leave this domain's migration and are S03's (S03's `20261010140000-tenancy-s03-expand.js` already adds the column; this domain's `20261001290000-public-api.js` also adds it, so the new migration here only drops the three FKs and never touches `sandboxOf`; the old migration is history and is not edited).
- S05 `ProductCommandService.create/update/getForShop/listByShop`, `ProductQueryService.getProductsByIds`, `ProductStockService.applyStockDelta`: used as they exist. `ProductService.create` mapping of empty brand → `Unbranded` is **not** relied on: the public contract requires `brand` (1–100) in its own DTO at the latest version, and the old version's request upgrader fills `Unbranded` explicitly (follow-up from S05).
- S10: `getOrdersForShop`, `getOrderLines` with `…Minor` money fields (follow-up from S10-cart-checkout); `getShopOrder` is added additively to `OrderQueryService` (one shop-scoped statement, `null` otherwise) with a test in the orders suite; listed under Sibling-spec follow-ups.
- S01: `Firewall({ sensitive: true })` replaces `@UseGuards(SessionNotRevokedGuard)`; no `throttle`/`skipThrottle`. `SecretBox` is **not adopted**: S42 has no new encrypted column (keys are hashed), stated to close the S01 follow-up.
- S50: `RateLimit`/`RateLimit-Policy` structured headers are emitted by the S50 interceptor; legacy `RateLimit-Limit/Remaining/Reset` and `X-RateLimit-*` are gone (spec FR-051 names the legacy three — the contract in `contracts/http.md` uses the structured pair and lists the discrepancy under Spec changes in `gaps.md`). `503 rate_limiter_unavailable` does not occur here (fail open); `422 rate_limit_cost_exceeded` is documented in the catalogue and returned when a batch cost exceeds the policy limit.
- S53: the shared HTTP idempotency store is the S54 one (`libs/infrastructure/idempotency`), not S53's.
- W07: `GET /api/developers/openapi.json` (same origin) is listed in `contracts/http.md` and served unauthenticated by `DevelopersModule` (R-14).

## R-13 Transactions (rule 4)

- **Decision**: every multi-statement write uses `TransactionRunner.run` (key create/rotate, pin, bulk job create, chunk apply, usage close, lifecycle revoke). The domain has 0 direct `sequelize.transaction` sites and 0 `// S54 T037 audit` comments (grep 2026-10-14; `.tx.baseline` = 0); none is added. No network call (S03/S05/S10 R1 calls, Redis, Kafka) runs inside a transaction; the order is "R1 lookups → transaction → after-commit tombstone/cache".
- Pool arithmetic (III.12): no pool is added; hot path = 0 DB statements on a cache hit; create key = 4 statements; rotate = 3; chunk apply = 2 + S05's.

## R-14 Contract, errors, transport (G-37…G-40)

- **Decision**: typed `ApiError` subclasses with `code` per the catalogue (`contracts/http.md`), mapped by the S54 filter; `type` URL `https://developers.marketplace.example/errors/<code>` (host from config). `PublicApiModule` sets: body limit 2 MiB (`413`), `Content-Type` check (`415`), `Accept` check (`406`), strict `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`), no CORS, `Cache-Control: no-store`, `405` problem for known paths with unknown methods, `404` problem for unknown paths, `HEAD` = `GET`. OpenAPI 3.1 is generated from zod schemas in `packages/contracts/src/developer-platform/` per version (schemas are the source; the controllers validate with them) and served at `/v1/openapi.json` (public API) and `/api/developers/openapi.json` (core, same origin, W07). `docs/security/owasp-api-top-10.md` is new; a contract test asserts every scenario ID it cites exists in `spec.md`.
- **Rejected**: `@nestjs/swagger` decorators as source (drifts from the zod used at the edge).

## R-15 Apps boot alone (L-004, L-015, L-018, L-019)

- `PublicApiModule` imports, itself, everything it needs: `TenancyModule` (S03 services), `CatalogModule`/`ProductModule` exports for the S05 services, `OrdersModule` exports for `OrderQueryService`, `RateLimitModule.forFeature`, `IdempotencyModule`, `CacheModule`, `ConfigModule` validation of `api_key_pepper`. `PublicApiWorkerModule` and `PublicApiProjectorModule` likewise. Wiring specs `apps/public-api/src/public-api-wiring.e2e-spec.ts`, `apps/worker/src/public-api-wiring.e2e-spec.ts`, `apps/projector/src/public-api-wiring.e2e-spec.ts`, `apps/core/src/developers-wiring.e2e-spec.ts` start each app module alone through `NestFactory` and assert the routes, consumers, jobs and policies are registered (pattern of S24); built-binary starts go to the final checkpoint script.

## R-16 Failure classes applied

| Lesson | Applied as |
|---|---|
| L-001 | Bulk-chunk queue is a standard queue; the producer validates options where the message is created (no `groupId`). |
| L-002, L-011 | `public-api-bulk-chunk` and `…-dlq` in `elasticmq.conf`; new tables only through real migrations; the doctor is compared in quickstart. |
| L-003 | No "A or B" assertions; AS-18/AS-56/AS-57/AS-61 force the fault and assert the exact degraded answer. |
| L-005, L-006 | Every test creates its own shops, keys and products through fixtures. |
| L-008 | Suite run in batches of fresh processes. |
| L-010 | `ensureSandboxShop` and the pin insert are idempotent (`409`-free: they return the existing row). |
| L-013 | Fault tests restore the switchable wrappers in `afterEach`. |
| L-016 | The purge and repair paths never exit non-zero on the condition they report. |
| L-017 | Existing scenarios of `public-api.e2e-spec.ts` are listed with their destination before deletion (tasks). |
