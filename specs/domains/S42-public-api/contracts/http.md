# Contract: S42 HTTP

Shapes only; the zod schemas (one set per supported version) live in `packages/contracts/src/developer-platform/` and are the source of the OpenAPI 3.1 description. Scenario references are `spec.md` AS-nn.

## A. Public API (app `public-api`, no prefix beyond `/v1`, `Authorization: Bearer sk_(live|test)_…`)

Common request headers: `Authorization` (required), `Marketplace-Version` (optional date), `Idempotency-Key` (required on the three creating POSTs), `If-Match` (required on `PATCH`), `X-Request-Id` (optional, echoed), `Content-Type: application/json` on bodies.

Common response headers on every authenticated response: `Request-Id`, `X-Client-Request-Id` (if sent and valid), `Marketplace-Version`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, structured `RateLimit` and `RateLimit-Policy` (S50; omitted when the limiter store is down, AS-56), `Retry-After` on `429`/`503`/brownout, `Deprecation` / `Sunset` / `Link` on deprecated routes and versions (also on errors), `Idempotent-Replayed: true` on a replay. The legacy `RateLimit-Limit|Remaining|Reset` and `X-RateLimit-*` do not exist.

| Route | Scope | Request | Success | Notes |
|---|---|---|---|---|
| `GET /v1/products` | `products:read` | `limit` 1…100 (20), `cursor`, `fields`, `expand=shop` | `200 {object:"list", data:[product], has_more, next_cursor}` | AS-37, AS-38 |
| `GET /v1/products/:id` | `products:read` | `fields`, `expand` | `200 product` + `ETag: "<version>"` | foreign/unknown → `404 resource_missing` (AS-16) |
| `POST /v1/products` | `products:write` | `{title 1…200, description?, price:{amount,currency}, category, brand 1…100, stock?}` | `201 product` + `ETag`, `Location` | `Idempotency-Key` required (AS-39, AS-53) |
| `PATCH /v1/products/:id` | `products:write` | `If-Match`, partial fields | `200 product` + new `ETag` | `428` absent, `412 version_conflict` stale, `409 product_archived` (AS-40) |
| `GET /v1/stock/:productId` | `products:read` | — | `200 {object:"stock", product_id, stock, livemode}` | AS-41 |
| `GET /v1/products/:id/stock` | `products:read` | — | as above | **deprecated** 2026-10-01 → sunset 2027-04-01, replacement `GET /v1/stock/{productId}`; `410 endpoint_retired` after (AS-32, AS-34) |
| `POST /v1/stock/bulk` | `stock:write` | `{items:[{operationId, productId, delta}]}` ≤ 10,000 | ≤ 100 items: `200 {object:"bulk_stock_update", status, items:[{operation_id, product_id, outcome, stock?}]}`; more: `202 {object, id:"bsu_…", status:"processing", total, chunks}` + `Location` | `Idempotency-Key` required; cost `ceil(items/100)` (AS-50…AS-52) |
| `GET /v1/stock/bulk/:jobId` | `stock:write` | — | `200 {object:"bulk_stock_update", id, status, total, applied, replayed, failed, failures:[…≤1000], completed_chunks, created_at}` | other shop's job → `404` |
| `GET /v1/orders` | `orders:read` | `limit`, `cursor`, `status?` | `200 list of order` | sandbox: empty list (AS-24, AS-42) |
| `GET /v1/orders/:id` | `orders:read` | — | `200 order` | sandbox and foreign → `404`; no buyer data |
| `POST /v1/batch` | per operation | `{operations:[{method, path, body?, ifMatch?, idempotencyKey?}]}` 1…50 | `200 {object:"batch", results:[{status, body, headers?}]}` | `Idempotency-Key` required; cost = operation count; 10 s budget (AS-43…AS-49) |
| `GET /v1/openapi.json` | none | — | `200` OpenAPI 3.1 | unauthenticated, no real key inside (AS-67) |

Other methods on known paths → `405` problem with `Allow`; unknown paths → `404` problem; `HEAD` = `GET` without body; `OPTIONS` answers without CORS headers (AS-69).

### Resource shapes (latest version `2026-10-01`; `2026-01-15` per AS-28)

- `product`: `{id, object:"product", livemode, title, description, price:{amount, currency}, stock, category, brand, status, version, created_at, updated_at}`. At `2026-01-15`: `price` is the integer `amount`, `stock` is named `quantity`.
- `order`: `{id, object:"order", livemode, status, total:{amount, currency}, lines:[{product_id, quantity, unit_price:{amount, currency}}], created_at}`. At `2026-01-15`: `total` integer + top-level `currency`, `unit_price` integer.
- `list`: `{object:"list", data, has_more, next_cursor}`.
- Every resource is built from an explicit public DTO; no internal field, hash, secret or buyer datum is serialized.

### Problem document (every error, public and dashboard)

`application/problem+json`: `{type, title, status, detail, instance, requestId, code, errors?: [{field, code}], retryable?}`. `5xx` detail is generic.

| Status | Codes |
|---|---|
| 400 | `validation_failed`, `invalid_version`, `invalid_cursor`, `invalid_expand`, `invalid_fields` |
| 401 | `invalid_api_key` (+ `WWW-Authenticate: Bearer`) |
| 403 | `insufficient_scope`, `shop_suspended`, `mfa_required` (dashboard) |
| 404 | `resource_missing`, `route_not_found` |
| 405 | `method_not_allowed` |
| 406 | `not_acceptable` |
| 409 | `shop_offboarding`, `request_in_progress`, `product_archived`, `key_revoked`, `key_expired`, `key_already_rotating` |
| 410 | `endpoint_retired`, `version_retired`, `endpoint_brownout` |
| 412 | `version_conflict` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `idempotency_key_required`, `idempotency_key_reused`, `unsupported_operation`, `key_limit_reached`, `rate_limit_cost_exceeded`, `stock_below_zero` |
| 428 | `precondition_required` |
| 429 | `rate_limited`, `quota_exceeded` (+ `Retry-After`) |
| 500 | `internal_error` |
| 503 | `service_unavailable` (+ `Retry-After: 5`), `batch_deadline_exceeded` (per batch operation, `retryable: true`) |

## B. Dashboard API (app `core`, session + `ShopScoped`, prefix `/api/shops/:shopId/developers`)

`Firewall({ sensitive: true })` on create, rotate, revoke and `PUT api-version`.

| Route | Permission | Body / query | Success |
|---|---|---|---|
| `POST keys` | `shop.manage`; live key needs `amr` ∋ `mfa` (`403 mfa_required`) | `{name, scopes[], livemode, expiresAt?}` | `201 {id, key, prefix, name, scopes, livemode, status, expiresAt, createdAt}` + `Cache-Control: no-store`; `422 key_limit_reached` at 25 |
| `GET keys` | `shop.manage` | `limit`, `cursor` | `{items:[{id, prefix, name, scopes, livemode, status, expiresAt, lastUsedAt, createdBy, createdAt, successorId?}], nextCursor}` |
| `POST keys/:keyId/rotate` | `shop.manage` (+ `mfa` for live) | `{overlapHours?: 0…168}` | `201` as create + `previousExpiresAt`; `409` per FR-005 |
| `DELETE keys/:keyId` | `shop.manage` | — | `204` (idempotent; another shop's key → `404`) |
| `GET api-version` | `shop.manage` | — | `{version, pinnedAt, supported:[{version, status, sunset?}], latest}` |
| `PUT api-version` | `shop.manage` | `{version}` | `200 {version, previousVersion, pinnedAt}`; unknown → `400 invalid_version`, retired → `422` |
| `GET logs` | `shop.read` | `requestId, status, route, keyId, livemode, from, to, limit, cursor` | `{items:[request row], nextCursor}` |
| `GET usage` | `shop.read` | `days 1…30, livemode, deprecated` | `{days:[{date, version, route, calls, errors, deprecatedCalls}], keys:[{keyId, version, route, calls, lastCallAt}]}` |
| `GET /api/developers/openapi.json` | none (same-origin, W07) | — | `200` OpenAPI 3.1 of both surfaces |

Dashboard routes keep their path and session authentication; they never accept an API key.

## C. Rate-limit policies (S50 registry, declared in `rate-limit-policies.ts`)

| Policy | Algorithm | Limit | Key | Fail mode | Cost |
|---|---|---|---|---|---|
| `public-api.default` | token bucket | 6,000 / 60 s | `apiKey` | open | 1; batch = operations; bulk = `ceil(items/100)` |
| `public-api.auth-failure.ip` | sliding window | 30 / 60 s | `ip` | closed | 1 per failed authentication |
