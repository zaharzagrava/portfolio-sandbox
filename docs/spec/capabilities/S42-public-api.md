---
id: S42
title: Seller public API: API keys, scopes, sandbox, date-pinned versions, deprecation headers, batch and bulk stock, request logs, usage metering
kind: capability
status: draft
generated_at: 3903109f
depends_on: [S54, S01, S03, S05, S10, S49, S50, S53]
concepts: [problem-json-errors, idempotency-key, rate-limit-policy, tenant-shop-rbac, request-context, outbox-task-queue, projection-and-replay, job-scheduler-lease, transaction-runner]
models: []
scope:
  - packages/backend/libs/domains/developer-platform/**
  - packages/backend/apps/public-api/**
  - packages/contracts/src/developer-platform/**
---
# S42 - Seller public API

## Purpose
A shop manager issues API keys for the shop. An integration (an ERP, a feed, a script) uses a key to read and write the shop's products, stock and orders over `/v1`, from its own servers. The key alone decides the shop. Test keys act on an isolated sandbox shop. Each shop is pinned to a dated API version, so a new version never breaks an existing integration. Calls are limited, logged and metered exactly once. See {{concept:tenant-shop-rbac}} for who may manage keys and {{concept:problem-json-errors}} for the error shape.

## Entry points
- Dashboard routes create, list, rotate and revoke keys and read and change the version pin. [code: packages/backend/libs/domains/developer-platform/api/api-keys.controller.ts#ApiKeysController]
- Public routes `GET|POST /v1/products`, `GET|PATCH /v1/products/:id`, `GET /v1/stock/:productId`, `POST /v1/stock/bulk`, `GET /v1/stock/bulk/:jobId`, `GET /v1/orders`, `GET /v1/orders/:id`, `POST /v1/batch`. [code: packages/backend/libs/domains/developer-platform/api/v1.controller.ts#V1Controller]
- Authentication guard: the first guard of every public route. [code: packages/backend/libs/domains/developer-platform/api/api-key.guard.ts#ApiKeyGuard]
- Request context middleware: server `Request-Id`, no-store, deprecation headers and one request record per authenticated call. [code: packages/backend/libs/domains/developer-platform/api/request-context.middleware.ts#RequestContextMiddleware]
- OpenAPI description of the public contract at `GET /v1/openapi.json`, also served to the dashboard at `GET /api/developers/openapi.json`. [code: packages/backend/libs/domains/developer-platform/application/openapi.builder.ts#buildOpenApi]
- Three jobs (`public-api.flush-key-usage`, `public-api.close-usage-minutes`, `public-api.purge-bulk-jobs`) and the consumers of shop lifecycle events, request records and the bulk chunk queue `public-api-bulk-chunk`. [code: packages/backend/libs/domains/developer-platform/public-api-worker.module.ts#PublicApiWorkerModule]
- Configuration keys: `api_key_pepper` (required), `api_key_pepper_previous` (optional).

## Rules
- **S42.R-01** A key MUST have the form `sk_live_` or `sk_test_`, a 12-character public prefix and a 32-character secret from a secure source; the full key MUST be returned once, at creation, and only a keyed hash of the secret MUST be stored. [proof: S42 AS-01, S42 AS-20] [code: packages/backend/libs/domains/developer-platform/domain/api-key-format.ts#generateApiKey]
- **S42.R-02** The hashing secret MUST be configured, and the app MUST refuse to start without it; a previous value MUST still verify keys, and a key verified with it MUST be re-hashed with the current one. [proof: S42 AS-21, S42 AS-20]
- **S42.R-03** A key MUST have exactly one derived status, in the order revoked, expired, rotating, active, and only the transitions of the lifecycle table MUST be allowed. [proof: S42 AS-07, S42 AS-10] [code: packages/backend/libs/domains/developer-platform/domain/key-status.ts#deriveKeyStatus]
- **S42.R-04** A shop MUST have at most 25 active or rotating keys, enforced under a row lock so concurrent creations cannot exceed it. [proof: S42 AS-05]
- **S42.R-05** Rotation MUST create a successor with the same scopes and mode and keep the old key valid for an overlap of 0 to 168 whole hours (default 24); a second rotation of the same key MUST be refused. [proof: S42 AS-06, S42 AS-07]
- **S42.R-06** Revocation MUST be idempotent and effective at once on every instance, including against a concurrent cache fill. [proof: S42 AS-08, S42 AS-09]
- **S42.R-07** Key routes and the pin route MUST be sensitive routes; creating or rotating a live key MUST require a fresh multi-factor step-up; managing keys MUST need `shop.manage` of the shop in the session. [proof: S42 AS-03, S42 AS-04]
- **S42.R-08** Each key lifecycle change MUST write exactly one event in the same transaction as the change, and no event MUST carry a secret. [proof: S42 AS-01, S42 AS-06, S42 AS-08]
- **S42.R-09** `lastUsedAt` MUST be written behind the request within one minute, never move backwards and never fail the request. [proof: S42 AS-11]
- **S42.R-10** A deleted shop MUST have all its keys revoked once, and a status change of the shop MUST apply to calls within 60 seconds; both consumers MUST be idempotent and refuse an invalid payload. [proof: S42 AS-12, S42 AS-17]
- **S42.R-11** Every credential failure (missing, malformed, unknown, wrong secret, wrong mode, revoked, expired) MUST give the same `401 invalid_api_key`, MUST be throttled per client address at 30 per minute, counted by reason and never written to a shop's log. [proof: S42 AS-13, S42 AS-14, S42 AS-25]
- **S42.R-12** Each public route MUST require its scope, checked after authentication and before any work, answering `403 insufficient_scope`. [proof: S42 AS-15]
- **S42.R-13** The shop MUST come only from the key; a record of another shop MUST answer `404 resource_missing` on every route, in a batch operation and in a bulk request. [proof: S42 AS-16, S42 AS-45]
- **S42.R-14** A call by a key of a suspended shop MUST answer `403 shop_suspended` and of an offboarding shop `409 shop_offboarding`. [proof: S42 AS-17]
- **S42.R-15** When the key store is down and the key is not cached the answer MUST be `503 service_unavailable`, never `401`; when only the fast store is down the system of record MUST decide. [proof: S42 AS-18]
- **S42.R-16** A secret MUST NOT appear in logs, records, events, errors or metric labels. [proof: S42 AS-19]
- **S42.R-17** A test key MUST act only on the shop's sandbox shop, created once on first use even under 10 parallel calls; a live key MUST never reach the sandbox; every resource MUST carry `livemode`; the sandbox MUST expose no orders and produce no usage or quota. [proof: S42 AS-22, S42 AS-23, S42 AS-24]
- **S42.R-18** Versions MUST be dates in one registry with a lifecycle; the first key MUST pin the shop to the latest version once, and a newer version MUST NOT move it. [proof: S42 AS-26, S42 AS-31]
- **S42.R-19** The version of a request MUST be the `Marketplace-Version` header, else the pin, else the latest, echoed in `Marketplace-Version`; an unknown value MUST answer `400 invalid_version`. [proof: S42 AS-27] [code: packages/backend/libs/domains/developer-platform/domain/versioning.ts#resolveVersion]
- **S42.R-20** Handlers MUST produce the latest shape only; registered transformers MUST downgrade responses and upgrade requests to the requested version, and `fields` and `expand` MUST use that version's names. [proof: S42 AS-28, S42 AS-29] [code: packages/backend/libs/domains/developer-platform/domain/versioning.ts#downgradeResponse]
- **S42.R-21** A manager MUST read and change the pin to any non-retired supported version; a change MUST apply on every instance within 5 seconds and be recorded as an event. [proof: S42 AS-30]
- **S42.R-22** A registry entry MUST have a sunset at least 6 months after its deprecation (30 days for an explicit security removal) and the latest version MUST never be retired. [proof: S42 AS-31] [code: packages/backend/libs/domains/developer-platform/domain/deprecation.ts#assertRegistryValid]
- **S42.R-23** A deprecated route or version MUST answer with `Deprecation`, `Sunset` and `Link` headers, also on an error; at or after its sunset it MUST answer `410` and inside a brownout window `410` with `Retry-After`. [proof: S42 AS-32, S42 AS-33, S42 AS-34] [code: packages/backend/libs/domains/developer-platform/domain/deprecation.ts#deprecationHeaders]
- **S42.R-24** Calls to a deprecated route or version MUST be flagged in the record and counted per key and route. [proof: S42 AS-35]
- **S42.R-25** Lists MUST use opaque keyset cursors with `limit` 1 to 100 (default 20) and strict validation; `expand` MUST accept only `shop`, at most 3 values, and use one batch lookup. [proof: S42 AS-37, S42 AS-38]
- **S42.R-26** A product MUST be created, updated and read only through the catalog's exported services; money MUST be integer minor units with the product's currency; an update MUST require `If-Match` (`428` absent, `412` stale) and responses MUST carry `ETag`. [proof: S42 AS-39, S42 AS-40, S42 AS-41]
- **S42.R-27** An order MUST show only the key's shop's lines and subtotal, with no buyer or payment data; every body MUST be built by an explicit public DTO. [proof: S42 AS-42]
- **S42.R-28** `POST /v1/batch` MUST take 1 to 50 batchable operations, run them in order, each with its own scope, tenant and idempotency, and not in one transaction; one failure MUST NOT stop the rest. [proof: S42 AS-43, S42 AS-44, S42 AS-46, S42 AS-47] [code: packages/backend/libs/domains/developer-platform/domain/batch-plan.ts#planBatch]
- **S42.R-29** A batch MUST have a 10 second budget; operations not started by then MUST answer `503 batch_deadline_exceeded` and MUST NOT run. [proof: S42 AS-49]
- **S42.R-30** Stock MUST be written as deltas with operation ids; up to 100 items MUST answer synchronously and 101 to 10,000 MUST become a durable job of chunks of 100, idempotent per chunk and scoped to the shop; unknown products MUST be reported per item. [proof: S42 AS-50, S42 AS-51, S42 AS-52] [code: packages/backend/libs/domains/developer-platform/domain/bulk-chunking.ts#splitIntoChunks]
- **S42.R-31** Every `POST` that creates MUST need `Idempotency-Key` (`422 idempotency_key_required`); a replay MUST return the stored response with `Idempotent-Replayed: true`; concurrent identical requests MUST have one effect. [proof: S42 AS-53, S42 AS-54]
- **S42.R-32** Each key MUST be limited by a shared token bucket (6,000 units a minute) answering `429` with the structured `RateLimit` and `RateLimit-Policy` headers; a batch MUST cost its operation count; a limiter outage MUST fail open and be counted. [proof: S42 AS-48, S42 AS-55, S42 AS-56]
- **S42.R-33** A live call MUST be checked against the monthly quota (cached 60 seconds); a refusal MUST answer `429 quota_exceeded` and an unavailable usage store MUST fail open. [proof: S42 AS-57]
- **S42.R-34** Each response MUST carry a server `Request-Id` and a valid client `X-Request-Id` MUST be echoed as `X-Client-Request-Id`; each authenticated call MUST yield exactly one `api.request_logged` record, produced without delaying the response and dropped (counted) rather than blocking when the bus is down. [proof: S42 AS-58, S42 AS-59, S42 AS-61]
- **S42.R-35** Request records MUST be searchable by shop and request id with keyset pagination and projected once per request id; a record of another shop MUST NOT be visible. [proof: S42 AS-60, S42 AS-62]
- **S42.R-36** The usage report MUST aggregate per day, version and route for 1 to 30 days. [proof: S42 AS-63]
- **S42.R-37** Billable usage MUST be derived from request records once per request id, bucketed per shop and UTC minute and emitted as `usage.recorded` exactly once per bucket, with a deterministic event id. [proof: S42 AS-64] [code: packages/backend/libs/domains/developer-platform/domain/usage-bucket.ts#usageEventId]
- **S42.R-38** Every error MUST be a problem document with a stable code from one catalogue and a generic detail on `5xx`; bodies MUST be limited to 2 MiB and content types, `Accept`, JSON syntax and unknown properties MUST be refused before a handler. [proof: S42 AS-65, S42 AS-66] [code: packages/backend/libs/domains/developer-platform/domain/errors.ts#ApiError]
- **S42.R-39** The OpenAPI description and per-version contract schemas MUST match real responses, changes inside a version MUST be additive, and the OWASP API Top 10 mapping MUST cite only scenarios that exist. [proof: S42 AS-36, S42 AS-67, S42 AS-68]
- **S42.R-40** Authenticated responses MUST be non-cacheable with safe transport headers, no origin MUST be granted by CORS, and a shutdown MUST stop readiness first and finish in-flight calls. [proof: S42 AS-69, S42 AS-71]

## Behaviors
- **S42.B-01** Given a manager with a fresh step-up, when they create a live key, then the response shows the full key once, a list never shows it again, and one `developerplatform.api_key_created` event exists. [proof: S42 AS-01]
- **S42.B-02** Given a key being rotated with a 24 hour overlap, when 24 hours pass, then the old key answers `401` and the new key works throughout. [proof: S42 AS-06, S42 AS-10]
- **S42.B-03** Given a revoked key, when any instance receives a call with it, then it answers `401 invalid_api_key`, even when a cache fill raced the revoke. [proof: S42 AS-08, S42 AS-09]
- **S42.B-04** Given a key of shop A and a product of shop B, when the key reads that product, then the answer is `404 resource_missing`, the same as for an unknown id. [proof: S42 AS-16]
- **S42.B-05** Given a shop with a pin of `2026-01-15`, when a product is read without a header, then the response has the older field names and carries the deprecation headers. [proof: S42 AS-28, S42 AS-33]
- **S42.B-06** Given a batch of 50 operations with one failing operation, when it runs, then the others apply and the failing one reports its own problem. [proof: S42 AS-46]
- **S42.B-07** Given a 10,000-item stock file with unknown products, when it is submitted twice with the same key, then one job exists, each known product changed once and each unknown one is reported `not_found`. [proof: S42 AS-52]
- **S42.B-08** Given the event bus is down, when an integration calls the API, then every response is as usual and the dropped records are counted. [proof: S42 AS-61]
- **S42.B-09** Given 1,000 calls in one minute with duplicated record deliveries, when the minute is closed, then exactly one `usage.recorded` with quantity 1,000 is emitted. [proof: S42 AS-64]

## Lifecycles
- Key status is derived, not stored: `active` becomes `rotating` when a successor is created, `active` or `rotating` becomes `revoked` by revoke, and `expired` follows from time alone. `revoked` wins over `expired`, which wins over `rotating`. Illegal moves answer `key_revoked`, `key_expired` or `key_already_rotating`.
- A bulk job is `processing` until every chunk is done, then `succeeded` (no failed item), `failed` (no applied or replayed item) or `partially_failed`.
- A version is `supported`, then `deprecated` with a sunset, then `retired`. The latest is never retired.

## Owns
- Tables `ApiKey`, `ShopApiSettings`, `ApiBulkJob`, `ApiBulkChunk`, `ApiUsageBucket`; no foreign key to another owner's table.
- ClickHouse table `api_requests` (30 day TTL).
- Queue `public-api-bulk-chunk` and its dead-letter queue.
- Events `developerplatform.api_key_created|rotated|revoked`, `developerplatform.api_version_pinned`, `api.request_logged` and `usage.recorded` (metric `api.calls`).
- Policies `public-api.default` and `public-api.auth-failure.ip`.
- Metrics: `public_api_deprecated_calls_total`, `public_api_request_log_dropped_total`, `public_api_quota_degraded_total`, failed-authentication counters by reason.

## Decisions
- The shop is read only from the key, so no header, path or body can name another tenant.
- Only a keyed hash with a mandatory pepper is stored, so a database copy cannot reveal a usable key.
- Handlers know only the latest shape; transformers per version keep old integrations working.
- The request context is mounted before body parsing, so a refused body still has an id and a record.
- Logging and metering never wait for the event bus; they buffer, retry and count drops.
- Billable usage is derived from records and closed 65 seconds after the minute, so late records still count once.
- The legacy `RateLimit-*` and `X-RateLimit-*` names are not offered; clients read the structured headers.

## Known gaps
- The monthly quota is checked through a billing adapter that always answers `not_available` (fail open) until billing exports `checkQuota`; AS-57 is proven with a fake port.
- Load goals (30,000 requests per second across 100,000 keys), 30 days of real retention and the browser journey of W04 have no automated proof; see `specs/UNVERIFIED.md`.
- AS-70 (table ownership and module boundaries) is a static gate and has no test title, so it has no proof clause here.
