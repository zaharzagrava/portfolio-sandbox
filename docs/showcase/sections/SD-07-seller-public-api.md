# SD-07 — Seller Public API & Developer Platform

Status: ☑ done (typechecked; specs written, not run) · Phase 5 · Depends on: SD-02, SD-28, SD-24 (metering), SD-30 (webhooks), SD-39

## Marketplace adaptation
Shops integrate their ERP/inventory systems: manage products, stock, orders via a **versioned public REST API** with API keys, sandbox mode, usage metering, webhooks, request logs.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **API keys**: `sk_live_` / `sk_test_` prefixes (leak scanning), only **hash** stored (SHA-256 + pepper; lookup by key prefix id), shown once, scoped (`products:write`), rotatable with overlap | 10/04 #7, 05/02 |
| Key verification cached (Redis, 60 s) → no DB per request | D23 |
| **Versioning**: URI major `/v1` + **date-based version pinning per shop** (`Marketplace-Version: 2026-10-01` header, default = shop's pinned version); version transformers translate responses between versions (Stripe-style) | 04/02 §2 |
| **Deprecation policy**: `Deprecation` + `Sunset` + `Link` headers middleware, usage telemetry per version/endpoint/shop (ClickHouse) to drive removal | 04/02 §3–7 |
| Idempotency keys on all POSTs (reuse README #3 store) | 04/03 §1 |
| Cursor pagination, sparse fieldsets (`fields=`), `expand=` embedding | 04/01 §2.3–2.4 |
| **Batch endpoint** `POST /v1/batch` (up to 50 ops) and bulk stock update | 04/01 §2.5 |
| Rate limits per key + plan quotas (SD-28, SD-24) + `RateLimit` headers | 04/03 §3 |
| **Sandbox mode**: test keys route to isolated data (`livemode` flag on rows) | 10/04 #7 |
| Request logs per shop (ClickHouse, searchable by request ID), OpenAPI as source of truth (Swagger existing) | 10/04 #7 |
| BOLA protection: every lookup scoped by shopId | 05/02 §7 |
| OWASP API Top 10 mapping documented | 05/02 §10 |

## Steps
- [x] `ApiKey` model (shopId, prefixId, hash, scopes, livemode, lastUsedAt write-behind), create/rotate/revoke endpoints.
- [x] `ApiKeyGuard` + scope decorator + CLS tenant set.
- [x] `apps/public-api/` (separate process: different auth, limits, scaling) with `/v1/products`, `/v1/stock`, `/v1/orders`, `/v1/batch`.
- [x] Version pinning + transformers registry + deprecation headers middleware.
- [x] Request log + usage events → Kafka → ClickHouse.
- [x] e2e: key of shop A can't read shop B order (404); revoked key → 401; v2026-01 response shape differs from v2026-10 per transformer; deprecated endpoint returns Sunset header.

## Scale
- Target: 30k RPS public API, 100k keys.
- Hot path: key → Redis cache → limiter → handler reading read models; usage/log → Kafka (async).
- First bottleneck: bulk stock updates from ERPs (100k SKUs) → batch endpoint → SQS task → batched upserts (not 100k requests).
- Proof: k6 mixed public API; p99 < 150 ms; per-key limits honoured across instances.

## Implementation notes (2026-10-01)
- **New deployable `apps/public-api`:** routes at `/v1` (`configureHttpApp(..., { globalPrefix: false })`), OpenAPI at `/docs`.
- **Keys** (`api-key-format.ts`, `ApiKeysService`):
  - Format `sk_live_|sk_test_<prefix12>_<secret32>`, base62 via rejection sampling.
  - Only `sha256(pepper:secret)` is stored, looked up by prefix and compared in constant time. The Redis cache (60 s) holds the hash, never "valid".
  - Revoke/rotate delete the cache entry; rotation gives 24 h overlap. `lastUsedAt` is write-behind (ZSET → one `UPDATE ... FROM unnest` per minute).
  - Unit spec `api-key-format.spec.ts`.
- **Sandbox:** test keys act on a lazily created shadow shop (`Shop.sandboxOf`, migration `20261001290000`), so all existing shop scoping and RLS isolate sandbox data with no `livemode` column anywhere.
- **`ApiKeyGuard` + `@ApiKeyAuth(...scopes)`:** the tenant comes only from the key into CLS; non-own resources are 404 (BOLA).
- **`PublicApiInterceptor`:**
  - Version from the `Marketplace-Version` header, else the shop's pin (cached), else latest. Handlers produce the latest shape; `VERSION_CHANGES` downgrades walk back (2026-10-01: `price` → money object, `quantity` → `stock`).
  - `Deprecation`/`Sunset`/`Link` headers from `DEPRECATED_ROUTES`.
  - `Request-Id`, and an async `api.request_logged` → ClickHouse `api_requests` + `api_usage_daily` MV (`clickhouse/060_api_requests.sql`), with the real status captured on errors.
- **Reusable `IdempotencyInterceptor`** (`libs/common/src/idempotency`): Redis claim (`SET NX` in-flight), 24 h stored response replayed with `Idempotent-Replayed`, 422 on fingerprint mismatch, 409 while in flight, 5xx releases the key.
- **Resources:**
  - Products: keyset cursor, `fields=` sparse fieldsets, `expand=shop`; create/patch go through the outbox → search projector.
  - Stock: `POST /v1/stock/bulk` — ≤ 100 items in one `UPDATE ... FROM unnest`; bigger batches go in 500-item SQS chunks (`bulk-stock-updates`) with job status.
  - Orders: the shop's slice only.
  - `POST /v1/batch`: ≤ 50 ops, per-op scope check and per-op results.
- **Dashboard** (`DevelopersModule`, core): `POST|GET /api/shops/:shopId/developers/keys`, `/keys/:id/rotate`, `DELETE /keys/:id`, `PUT /api-version`, `GET /logs?requestId=`, `GET /usage` (per version/route, which drives sunsets).
- **OWASP API Top 10 mapping:**
  - API1 BOLA: key-derived tenant + 404.
  - API2 auth: hashed keys, revocation.
  - API3 property-level: explicit serializers / `fields` allowlist.
  - API4 resource consumption: per-key token bucket + batch/bulk limits.
  - API5 function-level: scopes.
  - API8 misconfig: helmet/CORS shared bootstrap.
  - API9 inventory: versions + deprecations + usage telemetry.
- **Spec** `public-api/public-api.e2e-spec.ts`.
