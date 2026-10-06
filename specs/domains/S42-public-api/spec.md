# Feature Specification: S42 — Seller public API (API keys, scopes, sandbox, date-pinned versions, deprecation headers, batch, request logs) — domain `developer-platform`

**Feature Branch**: `S42-public-api` (spec directory `specs/domains/S42-public-api`)

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "Capability S42 — Seller public API: API keys, scopes, sandbox, date-pinned versions, deprecation headers, batch, request logs (domain `developer-platform`)." Sources: `docs/showcase/sections/SD-07-seller-public-api.md`; `interview-prep/04-api-design/02-api-versioning-and-deprecation.md`; `interview-prep/10-system-design/04-web-platform-architectures.md` (§7); the constitution (v3.1.0); `docs/architecture/pattern-map.md` rows P0214, P0403, P0404, P0411, P0412, P0414, P0516, P0519; the current code of `libs/domains/developer-platform` (an imperfect draft: where it disagrees with the notes, the notes win).

Companion files: [`questions.md`](questions.md) (decisions taken unattended, tagged, BREAKING first), [`test-plan.md`](test-plan.md) (constitution VII.8 table), [`gaps.md`](gaps.md) (what today's code lacks, debt rows, IX.7 replacements), [`checklists/requirements.md`](checklists/requirements.md).

## Scope

In scope:

- **API keys**: a shop's managers create, list, rotate and revoke secret keys (`sk_live_…`, `sk_test_…`). Each key has a name, scopes, an optional expiry, and a lifecycle. The secret is shown once and only a keyed hash is stored. Verification is fast on the hot path and refuses a revoked key at once. (P0516, P0214)
- **Scopes and tenant isolation**: every public call is authenticated by a key alone. The shop comes only from the key, every lookup is scoped to it, another shop's record answers `404`, and each endpoint (and each batch operation) needs its scope. (P0214, P0516)
- **Sandbox**: test keys act on an isolated sandbox shop created on first use. Nothing a test key does is visible to live keys or to buyers, and none of it is billed. (notes 10/04 §7)
- **The resources**: products (list, get, create, update), stock (read, bulk delta updates, asynchronous jobs for large files), and the shop's slice of orders (list, get), with cursor pagination, sparse fieldsets and depth-limited `expand`. (P0403)
- **Batch**: up to 50 operations in one request, each with its own result, scope check and idempotency, plus bulk stock for ERP-sized files. (P0404)
- **Date-pinned versions**: the shop is pinned to a version when it first creates a key. A per-request header can override it. Responses are downgraded, and requests upgraded, by registered transformers around one implementation. (P0411)
- **Deprecation**: a registry of deprecated routes and versions drives `Deprecation`, `Sunset` and `Link` headers, per-key usage telemetry, scheduled brownouts, and `410 Gone` after sunset. (P0412)
- **Idempotency, rate limits, quotas**: `Idempotency-Key` on every creating POST (replay, in-flight, different body, TTL), a per-key rate limit with `RateLimit` headers, and the plan's monthly call quota. (P0414)
- **Request logs and usage**: every authenticated call produces a request record that the shop can search by request ID for 30 days, a usage report per version and route, and exact billable usage events for the billing capability.
- **Key lifecycle events** and the shop's reaction to its own lifecycle (a deleted shop loses its keys; a suspended shop's keys stop working).
- **Developer security documentation**: the OWASP API Top 10 mapping and the OpenAPI description as the contract. (P0519)

Out of scope (owners named):

- Webhook endpoints, signing, delivery and replay → **S43** (same domain). The webhook payload's own version pinning is S43's; this capability exports the version registry it needs (see Cross-capability contracts).
- The embeddable storefront widget and its site keys (publishable, origin-bound) → **S44** (same domain). The secret keys here never run in a browser.
- Shops, roles, the `shop.manage` / `shop.read` permissions, the shop status gate, and creating the sandbox shop → **S03** (R1). Sessions, step-up and the `amr` claim → **S01 / S02**.
- Product storage, validation, stock arithmetic and the product events → **S05**. Orders and their lines → **S10**. This capability maps their data to the public shapes and never reads their tables.
- Plans, quotas and usage totals → **S17 / S18**. This capability produces the usage events and asks `checkQuota`.
- The rate-limit engine and its policy registry → **S50**. The idempotency store → the shared idempotency capability (P0414, first specified in S10). Outbox, inbox, consumers, DLQ → **S53**. Jobs → **S49**. Cache toolkit → **S52**. problem+json filter, request context, clock, config validation, metrics, shutdown → **S54**.
- The web screens for keys, version pin, logs and usage → **W04** (developer settings). This capability gives them the HTTP contract (the UI journey row lives in W04).
- Client SDKs, an interactive API console, OAuth apps acting for other users, publishable keys, per-key IP allow-lists, a sandbox reset button, secret-scanning partner callbacks, and a public status page (see Assumptions).

Cross-domain data used (IX.7):

- Shop identity and status, and the sandbox shop: **R1** — S03 `ShopQueryService.getShopsByIds` and `ShopProvisioningService.ensureSandboxShop`.
- Products and stock: **R1** — S05 `ProductQueryService`, `ProductCommandService`, `ProductStockService`.
- Orders: **R1** — S10 `OrderQueryService`.
- The monthly quota: **R1** — S18 `checkQuota`.
- Reactions to the shop's lifecycle (`tenancy.shop_status_changed`, `tenancy.shop_deleted`): domain events (IV.3), no shared table. The usage hand-over to billing: the event `usage.recorded` (billing consumes; **R3** pattern on billing's side).
- **R2 is not used.** No capability here composes screens. The dashboard routes belong to this domain and are called by the web app directly.

## Clarifications

Decided unattended; each is also in [`questions.md`](questions.md), BREAKING and CONTRACT first.

- Keys belong to the shop, not to the person who created them. They keep working when the creator leaves; the creator is recorded for audit only.
- A key's secret is stored only as a keyed hash; the key is refused with the same `401` for every reason (missing, malformed, unknown, wrong, revoked, expired) so the API gives an attacker no oracle.
- Creating or rotating a **live** key needs a session that passed a second factor (`mfa` in `amr`); test keys do not. All key and version-pin routes are "sensitive" (a revoked session is refused at once).
- The shop is pinned to the latest version when it creates its first key, not "latest at every call", so a new version never changes an integration that did not ask for it.
- Stock is written as **deltas** with an operation ID (all-or-nothing per request of up to 100, idempotent per operation ID), never as "set to N", which silently overwrites sales that happened in between. Product updates use `If-Match` with the product's version.
- Every `POST` that creates something requires `Idempotency-Key`; a missing key is a `422`.
- Sparse fieldsets and `expand` speak the **requested version's** field names. Requests written for an older version are accepted and upgraded.
- The request ID is always generated by the server; a client's own ID is only echoed and logged next to it.
- Request logs and metering are derived from the same per-request record. Logging is best-effort and never delays or fails a response; usage hand-over to billing is exact (deduplicated by request).
- When the plan-quota or rate-limit stores are unavailable the API **fails open** (and counts it); when the key store is unavailable it **fails closed** with `503`, never `401`.

## User Scenarios & Testing *(mandatory)*

Every acceptance scenario has a stable ID `AS-nn`; `test-plan.md` maps each to exactly one row. Defaults referenced below are listed under *Defaults* in Requirements. Errors are `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a stable `code`. "At `T`" means the injected clock reads `T`; the default clock is `2026-10-06T12:00:00Z`. Shops are `A` and `B`. "Key `A1`" is a live key of shop `A` with all four scopes (`products:read`, `products:write`, `orders:read`, `stock:write`); "`A1t`" is a test key of shop `A`; "`A-ro`" has only `products:read`. "Latest" is version `2026-10-01`; "old" is `2026-01-15`. Public routes are under `/v1`; dashboard routes under `/api/shops/:shopId/developers`.

### User Story 1 — A shop manager issues and controls API keys (Priority: P1)

A shop manager creates a key for the ERP, sees it once, later rotates it without downtime, revokes it when it leaks, and can always see which keys exist and when each was last used. No one else can touch the shop's keys.

**Why this priority**: keys are the only door to the public API; every other story starts from a key.

**Independent Test**: as a shop manager with a second-factor session, create a key and list keys; assert the secret is returned once and never again, and the stored value is not the secret.

**Acceptance Scenarios**:

1. **AS-01** (create, secret shown once) — **Given** a manager of shop `A` with a session that passed a second factor, **When** `POST /api/shops/A/developers/keys {name: "ERP", scopes: ["products:read","stock:write"], livemode: true}`, **Then** `201 {id, key, prefix, name, scopes, livemode: true, status: "active", expiresAt: null, createdAt}` where `key` matches `sk_live_<12 chars>_<32 chars>` and `prefix` is its 12-character middle part; the response carries `Cache-Control: no-store`; **When** `GET /api/shops/A/developers/keys`, **Then** the page contains the same key with `prefix`, `name`, `scopes`, `livemode`, `status`, `expiresAt`, `lastUsedAt: null`, `createdBy` and never `key`, `secret` or any hash; the stored credential is a keyed hash that differs from the secret; one event `developer_platform.api_key_created` (no secret) is committed with the key row (same commit).
2. **AS-02** (create validation) — **Given** the same manager, **When** the body has `name` empty or longer than 60, `scopes` empty, an unknown scope (`"admin:all"`), duplicate scopes, a non-boolean `livemode`, `expiresAt` in the past, `expiresAt` more than 365 days away, or an unknown extra property, **Then** each answers `400 validation_failed` with `errors: [{field, code}]` naming the field, and no key row and no event exist.
3. **AS-03** (who may manage keys) — **Given** shop `A` and shop `B`, **When** a request has no session, **Then** `401`; **When** a member of `A` without `shop.manage` creates, rotates or revokes, **Then** `403`; **When** a member of `B` calls any key route of `A`, **Then** `404`; **When** a manager of `A` rotates or revokes key `B1` (another shop's key ID) through `/api/shops/A/…`, **Then** `404 resource_missing` and `B1` is unchanged.
4. **AS-04** (sensitive routes and step-up) — **Given** a manager whose session was logged out (token not yet expired), **When** any key route or the version-pin route is called, **Then** `401` immediately; **Given** a session without `mfa` in `amr`, **When** creating or rotating a **live** key, **Then** `403 mfa_required` and nothing changes; **When** creating a **test** key, **Then** `201`; **When** revoking any key without `mfa`, **Then** `204` (revoking is never blocked by step-up).
5. **AS-05** (active-key limit, concurrent) — **Given** shop `A` has 24 active keys, **When** 5 creations run in parallel with `Promise.all`, **Then** exactly 1 answers `201` and 4 answer `422 key_limit_reached`, and `A` has exactly 25 active keys; revoked and expired keys do not count; a rotating key counts once (the successor replaces it after the overlap).
6. **AS-06** (rotate) — **Given** active key `A1` with scopes `S` at `T`, **When** `POST …/keys/A1/rotate {overlapHours?: 24}`, **Then** `201` with a new full key (same scopes, same `livemode`, name `"<name> (rotated)"`, `previousExpiresAt = T + 24 h`); `A1` now has `status: "rotating"` and `expiresAt = T + 24 h`; both keys authenticate until `T + 24 h − 1 s`; at `T + 24 h`, `A1` answers `401` and the successor still works; `overlapHours: 0` expires `A1` at `T`; `overlapHours` outside `0…168` or fractional → `400 validation_failed`; one event `developer_platform.api_key_rotated {keyId, successorId, …}`.
7. **AS-07** (illegal rotations, concurrent) — **Given** a revoked key, **When** rotate, **Then** `409 key_revoked`; **Given** a key past its expiry, **Then** `409 key_expired`; **Given** a key already rotating, **Then** `409 key_already_rotating` (and no second successor is created); **Given** an active key, **When** 2 rotations run in parallel, **Then** exactly 1 answers `201` and 1 answers `409 key_already_rotating`, exactly one successor exists, and the key limit (AS-05) is not exceeded by the pair.
8. **AS-08** (revoke is immediate and idempotent) — **Given** `A1` used successfully a moment ago on instance 1 and instance 2, **When** `DELETE …/keys/A1`, **Then** `204`, the key shows `status: "revoked"`, and the very next call with `A1` on **either** instance answers `401`; a second `DELETE` answers `204`, changes nothing and emits no second event `developer_platform.api_key_revoked`; revoking a rotating key also works and does not touch its successor.
9. **AS-09** (revoke races a verification) — **Given** a key whose cache entry is cold, **When** a call with it and a revoke run in parallel (`Promise.all`, repeated 20 times), **Then** after the revoke has returned `204`, no later call with that key ever answers `2xx`, even if the racing call was filling the key cache; a call that started before the revoke committed may succeed or fail but never changes that outcome.
10. **AS-10** (expiry) — **Given** a key created with `expiresAt = 2026-10-07T00:00:00Z`, **When** called at `2026-10-06T23:59:59Z`, **Then** `200`; at `2026-10-07T00:00:00Z`, **Then** `401 invalid_api_key`; the list shows `status: "expired"`.
11. **AS-11** (last use is write-behind and monotonic) — **Given** `A1` called at `T` and `T + 20 s`, **When** the minute flush runs, **Then** `lastUsedAt = T + 20 s` (precision ≤ 1 minute, never in the future, never earlier than a previously stored value even if an older batch is flushed late); a call whose use record is lost (fast store restarted) still succeeds and only leaves `lastUsedAt` older.
12. **AS-12** (shop lifecycle reaches the keys) — **Given** shop `A` has 3 keys, **When** the event `tenancy.shop_deleted {shopId: A}` is delivered, **Then** all 3 keys are revoked once (3 `api_key_revoked` events, reason `shop_deleted`), their sandbox data is left to the owners of that data, and every call answers `401`; **When** the same event is delivered a second time, **Then** nothing changes and no event is emitted; **When** an event with an invalid payload arrives, **Then** it is dead-lettered with its reason and nothing changes.

---

### User Story 2 — An integration authenticates, and only reaches its own shop (Priority: P1)

An ERP calls the API with a bearer key. It sees only its own shop's data, only what its scopes allow, and gets the same refusal for every kind of bad key.

**Why this priority**: broken object-level authorization and weak authentication are the top API risks (OWASP API1/API2/API5); this story is the security core.

**Independent Test**: create a product with key `A1`; read it with `B1` (404) and with `A-ro` (200); then revoke `A1` (401).

**Acceptance Scenarios**:

1. **AS-13** (one refusal for every bad key) — **Given** a protected route, **When** called with no `Authorization`, a `Basic` scheme, `Bearer` with an empty or malformed token, an unknown prefix, the right prefix with a wrong secret, a revoked key, an expired key, or a key placed in the query string (`?api_key=…`) instead of the header, **Then** every case answers the same `401` with `code: "invalid_api_key"`, the same `detail`, and `WWW-Authenticate: Bearer`; the body and timing reveal no difference between "unknown" and "wrong secret"; a failed call is not written to any shop's request log.
2. **AS-14** (failed-authentication throttle) — **Given** one client address, **When** it sends 31 failed authentications within one minute, **Then** the 31st and later answer `429 rate_limited` with `Retry-After`; a valid key from the same address is still served until its own limit; the limit is per address, not per key prefix tried, and a counter `public_api_auth_failures_total{reason}` (reasons: `malformed`, `unknown`, `mismatch`, `revoked`, `expired`) increases by one per failure (the reason is never in the response).
3. **AS-15** (scopes per endpoint) — **Given** key `A-ro` (`products:read` only), **When** it calls each route, **Then** reads of products and stock succeed; `POST/PATCH /v1/products`, `POST /v1/stock/bulk`, `GET /v1/stock/bulk/:id` and `GET /v1/orders*` answer `403 insufficient_scope` with `required: ["<scope>"]`; scopes are `products:read` (products, stock read), `products:write` (create, update), `stock:write` (bulk stock and its jobs), `orders:read` (orders); `POST /v1/batch` needs no scope of its own (AS-48 checks per operation); a scope check happens after authentication and before any work.
4. **AS-16** (cross-tenant access returns 404) — **Given** products `PA` of shop `A` and `PB` of shop `B`, and order `OA` of `A`, **When** key `A1` requests `GET /v1/products/PB`, `PATCH /v1/products/PB`, `GET /v1/stock/PB` or `GET /v1/orders/OB`, **Then** every answer is `404 resource_missing` identical to the answer for a random unknown ID (same body shape, same `detail` pattern), and shop `B`'s data is unchanged; a list never contains another shop's rows; a bulk stock item naming `PB` answers `outcome: "not_found"` and `PB`'s stock is unchanged; a cursor issued to `A` and used by `B` returns only `B`'s rows.
5. **AS-17** (shop status gate) — **Given** shop `A` is suspended (S03 status), **When** `A1` calls any route (after the staleness bound), **Then** `403 shop_suspended`; **Given** shop `A` is offboarding, **Then** `409 shop_offboarding`; **When** `tenancy.shop_status_changed` is delivered, **Then** the next call sees the new status on every instance; with no event the status is seen at most 60 s late; reads and writes are both refused; the dashboard routes follow S03's own status gate.
6. **AS-18** (key store degraded) — **Given** the fast shared store is down, **When** `A1` calls, **Then** `200`: the key is verified from the system of record (counter `public_api_key_cache_degraded_total` +1 per call); an unknown or revoked key is still `401`; **Given** the system of record is also unreachable and the key is not cached, **Then** `503 service_unavailable` (never `401`) with `Retry-After: 5`, and counter `public_api_auth_unavailable_total` +1; a cached, valid key keeps working for up to 60 s during that outage.
7. **AS-19** (secrets never leak) — **Given** a full run of creating, rotating and calling with a key and with a deliberately wrong key, **When** all logs, request records, emitted events, error bodies, metrics labels and traces are scanned, **Then** the plaintext key, its 32-character secret and the `Authorization` header value appear nowhere; request records hold the key's `id`, never its prefix-plus-secret; the key's `prefix` appears only in the dashboard list and in the creation response.
8. **AS-20** (key format and verification are sound) — **Given** table-driven inputs, **When** a key is generated, parsed and verified, **Then** it has the shape `sk_(live|test)_<12 base62>_<32 base62>`, 10,000 generated secrets show uniform symbol use (no modulo bias), parsing rejects every malformed shape, the stored value is the keyed hash of the secret (not reversible, different pepper → different hash), comparison is constant-time and rejects a different-length value, and two keys never share a prefix (a collision on creation is retried, never overwritten).
9. **AS-21** (the pepper is mandatory) — **Given** the service starts without the key-hashing secret configured (or with the same value as another secret), **When** it boots, **Then** startup fails with a configuration error naming the missing setting; a previous pepper may be configured next to the current one so that keys hashed with it still verify and are re-hashed on next use.

---

### User Story 3 — Developers test against an isolated sandbox (Priority: P1)

A developer builds the integration with a test key. The sandbox is a separate shop that behaves like a real one, is created on first use, never touches live data, and costs nothing.

**Why this priority**: it removes the main fear of going live and is the notes' "sandbox/test mode" pattern.

**Independent Test**: with `A1t` create a product; list with `A1t` (1 item) and `A1` (0 items).

**Acceptance Scenarios**:

1. **AS-22** (isolation both ways) — **Given** `A1t` and `A1`, **When** `A1t` creates product `X`, **Then** `201` with `livemode: false`; `A1t` lists `[X]`; `A1` lists none and `GET /v1/products/X` with `A1` is `404`; **When** `A1` creates `Y`, **Then** `A1t` does not see `Y`; the sandbox product is marked as a sandbox product in the catalog (`isSandbox: true` through S05) and never appears in the storefront, search or any buyer-facing read; every resource returned by a test key has `livemode: false` and by a live key `livemode: true`.
2. **AS-23** (first use creates exactly one sandbox shop) — **Given** a test key never used, **When** 10 first calls run in parallel, **Then** all answer `200/201`, exactly one sandbox shop exists for `A` (S03 `ensureSandboxShop`, idempotent), it has no members and no payout settings, and all 10 acted on the same sandbox shop; deleting or suspending `A` does not leave the sandbox usable (AS-12, AS-17 apply to it through the live shop).
3. **AS-24** (sandbox has no orders, no billing) — **Given** `A1t`, **When** `GET /v1/orders` → `200` with `data: []`, `has_more: false`; `GET /v1/orders/<any id>` → `404`; **When** test calls are made, **Then** their request records carry `livemode: false`, they produce **no** `usage.recorded` event, do not count toward the monthly quota (AS-57), and still use the rate limit of their own key.
4. **AS-25** (key mode is bound to the key) — **Given** a live key `sk_live_<p>_<s>`, **When** the same prefix and secret are presented as `sk_test_<p>_<s>` (and the reverse), **Then** `401 invalid_api_key`; a live key can never act on the sandbox shop and a test key can never act on the live shop.

---

### User Story 4 — Versions are pinned per shop and evolve by transformers (Priority: P1)

An integration written against one version keeps working when a new version ships. Each shop is pinned; a header overrides per request; old shapes are produced from one implementation.

**Why this priority**: P0411, the headline pattern of the notes (date-pinned versions with transformers).

**Independent Test**: create a product, read it as old and as latest; pin the shop to old and read it with no header.

**Acceptance Scenarios**:

1. **AS-26** (first key pins the shop) — **Given** shop `A` has no pin and the latest version is `2026-10-01`, **When** its first key is created (live or test), **Then** shop `A` is pinned to `2026-10-01` in the same commit (a second concurrent first-key creation leaves exactly one pin row and the same value); **Given** a newer version `2027-03-01` is later registered, **When** `A1` calls with no header, **Then** responses still use `2026-10-01`; a shop created after that is pinned to `2027-03-01`; a shop that somehow has no pin is pinned to the latest at its first authenticated call (once).
2. **AS-27** (resolution order and echo) — **Given** shop `A` pinned to latest, **When** a call has `Marketplace-Version: 2026-01-15`, **Then** the old shape is returned and the header `Marketplace-Version: 2026-01-15` is echoed; with no header the pinned version is used and echoed; a value that is not a supported version string (`1999-01-01`, `latest`, `2026-1-1`, two headers) answers `400 invalid_version` listing the supported versions and does no work; the header never changes the stored pin.
3. **AS-28** (responses are downgraded by transformers) — **Given** product `P` (price 129,900 minor, currency `C`, stock 5), order `O` (total 129,900), **When** read at latest, **Then** product `{id, object:"product", livemode, title, description, price:{amount:129900, currency:C}, stock:5, category, brand, status, version, created_at, updated_at}` and order `{id, object:"order", livemode, status, total:{amount, currency}, lines:[{product_id, quantity, unit_price:{amount, currency}}], created_at}`; **When** read at `2026-01-15`, **Then** product has `price: 129900` and `quantity: 5` (no `stock`) and order has `total: 129900`, `currency`, and `unit_price` as integers; lists transform each item and keep `has_more`/`next_cursor`; fields added later to a version's shape (`livemode`, `status`, `version`) appear in every version (additive); an unknown newer-than-latest or older-than-oldest version is never reachable.
4. **AS-29** (requests are upgraded; fields speak the requested version) — **Given** shop `A` and `Marketplace-Version: 2026-01-15`, **When** `POST /v1/products {title, price: 129900, quantity: 5, category}`, **Then** `201` and the stored product equals the one created at latest with `{price: {amount: 129900, currency}, stock: 5}`; at latest, `price: 129900` (a bare number) answers `400 validation_failed` (`price` must be an object), and `quantity` is an unknown property (`400`); `?fields=title,quantity` at the old version returns `{id, object, title, quantity}`; the same `fields` at latest answers `400 invalid_fields` naming `quantity`; the response is always shaped for the requested version.
5. **AS-30** (pin the version from the dashboard) — **Given** a manager (second factor not needed), **When** `PUT /api/shops/A/developers/api-version {version: "2026-01-15"}`, **Then** `200 {version, previousVersion, pinnedAt}`; calls with no header on any instance use it within 5 s (the instance that served the change, at once); `GET` of the same resource returns the current pin; an unknown version → `400`; a retired version → `422 version_retired`; the same version again → `200` with no event; two concurrent pins leave one value (the later commit) and every instance agrees within 5 s; a member without `shop.manage` → `403`; another shop's `shopId` → `404`; one event `developer_platform.api_version_pinned {shopId, version, previousVersion, actorId}` per change.
6. **AS-31** (transformer registry rules) — **Given** table-driven registries, **When** the registry is validated at startup and in tests, **Then**: versions are unique, strictly ascending, ISO dates; the latest version is not retired; every change lists a downgrade for each resource type it touches and an upgrade for each request body it touches; downgrading a resource through every supported version and upgrading a request back is lossless for fields that exist in both shapes (property test); a registry with a sunset earlier than 6 months after deprecation, a missing downgrade, or an out-of-order version fails startup; adding a version is one registry entry and no handler changes.

---

### User Story 5 — Deprecations are announced, measured and enforced (Priority: P2)

Before an endpoint or version goes away, every call to it says so in headers. The shop can see which keys still use it, brownouts flush out forgotten callers, and after sunset the answer is `410` with a pointer to the replacement.

**Why this priority**: P0412; the notes require a process (headers, telemetry, brownouts, `410`), not just `/v2`.

**Independent Test**: call the deprecated stock route and read its three headers; then advance the clock past the sunset and see `410`.

**Acceptance Scenarios**:

1. **AS-32** (deprecated route announces itself) — **Given** `GET /v1/products/:id/stock` is registered as deprecated on `2026-10-01` with sunset `2027-04-01` and replacement `GET /v1/stock/{productId}`, **When** called with a valid key at the default clock, **Then** `200` with `Deprecation: @1790812800` (the deprecation instant in Unix seconds, RFC 9745), `Sunset: Thu, 01 Apr 2027 00:00:00 GMT` (RFC 8594), and `Link: <https://docs.marketplace.dev/api/deprecations>; rel="deprecation"; type="text/html", </v1/stock/{productId}>; rel="successor-version"`; `GET /v1/stock/:productId` has none of the three; the headers are also present when the same deprecated route answers `404`, `403` or `429`.
2. **AS-33** (deprecated version announces itself) — **Given** version `2026-01-15` is registered as deprecated on `2026-10-01` with sunset `2027-04-01`, **When** any call is served at that version (by header or by pin), **Then** the same `Deprecation`, `Sunset` and `Link` (docs link and `rel="successor-version"` to the migration guide of the latest version) headers are present, `deprecated: true` is in the request record, and calls at the latest version carry none.
3. **AS-34** (after sunset: `410`, brownouts) — **Given** the route's sunset is `2027-04-01T00:00:00Z`, **When** called at `2027-04-01T00:00:00Z` or later, **Then** `410 Gone` problem `code: "endpoint_retired"` with `successor` and a `Link … rel="successor-version"` header; calls to the replacement are unaffected; **Given** a brownout window `[2027-01-10T10:00Z, 2027-01-10T11:00Z)` is registered, **When** called at `10:30Z`, **Then** `410` with `code: "endpoint_brownout"` and `Retry-After` = seconds to `11:00Z`; at `11:00Z` it answers `200` again; a call at a retired **version** answers `410 version_retired` and pointers to the supported versions; the retired answer is itself logged (AS-58) and counted.
4. **AS-35** (deprecation telemetry drives removal) — **Given** key `A1` called the deprecated route 3 times on day `D` and key `A2` once, **When** `GET /api/shops/A/developers/usage?deprecated=true`, **Then** the rows list per `(version, route, keyId)` the calls, errors and `lastCallAt`, so the shop (and the platform owner) can see who still calls it; the metric `public_api_deprecated_calls_total{route,version}` rose by 4 (no per-key label, per-key data lives in the usage report); a route not called for 30 consecutive days has no row; another shop's calls are never included.
5. **AS-36** (the registry is a contract) — **Given** the OpenAPI description of the public API, **When** inspected, **Then** every deprecated route is marked `deprecated: true` with its sunset and replacement in the description, and no route absent from the registry carries deprecation headers; removing or changing a field within an existing version fails the contract check (changes within a version are additive only).

---

### User Story 6 — Products, stock and orders are readable and writable safely (Priority: P1)

The ERP lists and updates products, syncs stock in bulk, and reads the shop's slice of orders, with stable paging and no lost updates.

**Why this priority**: the resources are the reason the API exists.

**Independent Test**: create 3 products, page through them with limit 2, update one with `If-Match`.

**Acceptance Scenarios**:

1. **AS-37** (cursor pagination is stable) — **Given** 5 products of `A`, **When** `GET /v1/products?limit=2` then follow `next_cursor`, with a product inserted by another request between the pages, **Then** the three pages contain each pre-existing product exactly once, no product twice, in a deterministic order that ends in a unique tiebreaker, `has_more` is `true`, `true`, `false`, and the last `next_cursor` is `null`; `limit` defaults to 20 and must be `1…100`; `limit=0`, `101`, `abc`, `1.5`, or a cursor that is not one we issued answer `400` (`validation_failed` / `invalid_cursor`) and never clamp silently; the cursor is opaque and carries no shop ID (AS-16).
2. **AS-38** (sparse fieldsets and `expand`) — **Given** a product list, **When** `fields=title,price`, **Then** each item has exactly `{id, object, title, price}`; an unknown field → `400 invalid_fields` naming it; `expand=shop` adds `shop: {id, name, slug}` of the acting shop to each item using one batch call for the whole page (never one call per row); any other value (`expand=orders`), a dotted path (`expand=shop.owner`, depth > 1) or more than 3 values → `400 invalid_expand`; `fields` and `expand` combine; for a list of 100 the number of shop lookups is 1.
3. **AS-39** (create a product) — **Given** key `A1`, **When** `POST /v1/products` with `Idempotency-Key` and `{title, price: {amount: 129900, currency: C}, stock: 5, category, brand?}`, **Then** `201` with `Location: /v1/products/<id>` and the product (including `version: 1`), created through S05's command service with the key's `createdBy` as actor; the shop's products total rises by 1; one product event is emitted by S05 (not by this capability); **When** the body has `price.amount` of `0`, negative, fractional, above `10,000,000,000`, a `currency` different from the platform currency, `title` empty or over 200, `stock` negative or fractional, a missing `category`, or an extra property, **Then** each answers `400 validation_failed` with the field, and nothing is created; a shop that is not active → `403 shop_suspended` (from S05's `ShopNotActiveError`).
4. **AS-40** (update with optimistic concurrency) — **Given** product `P` at `version: 7` (`ETag: "7"` on every product response), **When** `PATCH /v1/products/P` with `If-Match: "7"` and `{title}`, **Then** `200` with `version: 8`; without `If-Match` → `428 precondition_required`; with a stale `"6"` → `412 version_conflict` with the current version in `detail` and nothing changed; **When** 2 `PATCH` with `If-Match: "8"` run in parallel, **Then** exactly 1 answers `200` and 1 answers `412`, and the stored version is `9`; an archived product → `409 product_archived`; an empty body or a body with no changeable field → `400`; `price` and `stock` follow AS-39's rules; `PATCH` of another shop's product → `404` (AS-16).
5. **AS-41** (stock read and the deprecated route) — **Given** product `P` with stock 5, **When** `GET /v1/stock/P`, **Then** `200 {object: "stock", product_id: P, stock: 5, updated_at}`; `GET /v1/products/P/stock` answers `200 {product_id, stock}` with the deprecation headers of AS-32; both need `products:read`.
6. **AS-42** (orders: the shop's slice only) — **Given** order `O` with lines from shops `A` and `B`, **When** `A1` calls `GET /v1/orders` and `GET /v1/orders/{id}`, **Then** only shop `A`'s part appears: `{id (the shop-order id), object: "order", livemode, status, total (A's subtotal), lines (only A's lines: product_id, quantity, unit_price), created_at}`; no buyer identifier, e-mail, address or payment data is present anywhere; `?status=` filters by a known order status (unknown → `400`); pagination follows AS-37 (newest first); `GET /v1/orders/<B's shop-order id>` → `404`; `status` values are passed through from the order capability and clients must tolerate new values (documented in the contract); the order data is obtained through the order capability's exported service, in one call for the lines of a whole page.

---

### User Story 7 — Batch and bulk stock for ERP-sized work (Priority: P2)

An ERP packs up to 50 operations into one request and syncs thousands of stock changes without thousands of calls. Each operation reports its own result, failures do not undo earlier work, and retries are safe.

**Why this priority**: P0404, and the notes' "first bottleneck" (bulk stock from ERPs).

**Independent Test**: batch of one create, one read, one patch with a bad version; check three results and the first one persisted.

**Acceptance Scenarios**:

1. **AS-43** (batch happy path) — **Given** key `A1`, **When** `POST /v1/batch` with `Idempotency-Key` and `operations: [ {method:"POST", path:"/v1/products", idempotencyKey:"k1", body:{…}}, {method:"GET", path:"/v1/products/<id>"}, {method:"PATCH", path:"/v1/products/<id>", ifMatch:"1", body:{title:"x"}} ]`, **Then** `200 {object:"batch", results:[{status:201, body:<product>}, {status:200, body:<product>}, {status:200, body:<product>}]}` in the same order, executed in order; every body is shaped for the requested version; the batchable operations are exactly `GET|POST|PATCH /v1/products[/:id]` and `GET /v1/stock/:productId`.
2. **AS-44** (batch input limits) — **Given** key `A1`, **When** `operations` is empty, has 51 entries, has an entry whose `method` is not `GET|POST|PATCH`, whose `path` does not match `^/v1/[\w/-]+$`, or an unknown property, **Then** the whole request answers `400 validation_failed` and **no** operation ran; **When** an operation targets a valid but non-batchable route (`/v1/batch`, `/v1/orders`, `/v1/stock/bulk`, a deprecated route), **Then** that operation's result is `{status: 422, body: {code: "unsupported_operation", …}}` and the others run; nested batches are never executed; the body is at most 2 MiB (`413 payload_too_large` above).
3. **AS-45** (per-operation scope and tenant) — **Given** key `A-ro`, **When** a batch contains a `GET` product and a `POST` product, **Then** result 1 is `200` and result 2 is `{status: 403, body: {code: "insufficient_scope", required: ["products:write"]}}` (not `400`), and nothing was created; an operation naming another shop's product answers `404` in its own result; the batch itself is `200`.
4. **AS-46** (failures are isolated; not one transaction) — **Given** a batch of 3 operations whose second fails validation, **When** executed, **Then** results are `[201, 400 {code:"validation_failed", errors}, 200]`; operation 1's product persists and operation 3 ran; every failed result is a problem body (`type`, `title`, `status`, `detail`, `code`) without `instance`-leaking internals; a thrown internal error becomes `{status: 500, body: {code: "internal_error"}}` with a generic detail and the batch continues.
5. **AS-47** (batch idempotency) — **Given** a batch with `Idempotency-Key: b1`, **When** replayed with the same body, **Then** the stored response is returned with `Idempotent-Replayed: true` and nothing runs again; the same key with a different body → `422 idempotency_key_reused`; the same key while the first is running → `409 request_in_progress`; a missing `Idempotency-Key` → `422 idempotency_key_required`; **Given** a first attempt where operation 2 failed, **When** a new batch (new `Idempotency-Key`) repeats all three operations with the **same operation `idempotencyKey`s**, **Then** operation 1 returns its stored result (`Idempotent-Replayed: true` in the result's `headers`, no second product), operation 2 runs, operation 3 re-applies safely; a `POST` operation without `idempotencyKey` answers `{status: 422, body: {code: "idempotency_key_required"}}` and does not run; operation keys are scoped to the acting shop and the operation's route.
6. **AS-48** (batch costs what it contains) — **Given** a per-key limit of `L` per minute, **When** a batch of 50 operations is accepted, **Then** it consumes 50 units; with fewer than 50 units left it answers `429 rate_limited` with `Retry-After` and none of the 50 runs; a request with a single operation consumes 1 unit; bulk stock consumes `⌈items ÷ 100⌉` units.
7. **AS-49** (batch has a time budget) — **Given** a batch of 50 operations and a 10-second budget, **When** the budget is exhausted before operation 31 starts, **Then** operations 1–30 have their real results, operations 31–50 have `{status: 503, body: {code: "batch_deadline_exceeded", retryable: true}}` and **did not run**, the batch itself answers `200`, and the stored idempotent response is these results; no operation is cut off mid-execution.
8. **AS-50** (bulk stock, up to 100 items, synchronous) — **Given** products `P1,P2` of `A` with stock 5 and 3 and `PB` of `B`, **When** `POST /v1/stock/bulk` with `Idempotency-Key` and `items: [{operationId:"o1", productId:P1, delta:-2}, {operationId:"o2", productId:P2, delta:10}, {operationId:"o3", productId:PB, delta:1}]`, **Then** `200 {object:"bulk_stock_update", status:"succeeded", results:[{operation_id:"o1", product_id:P1, outcome:"applied", stock_after:3}, {…"o2", "applied", 13}, {…"o3", outcome:"not_found"}]}` — the missing and foreign products are found in one batch lookup and are not applied, the rest is applied atomically through the stock service, and one stock change event per product comes from S05; **When** an item would take stock below zero, **Then** `status: "failed"`, that item `outcome: "insufficient_stock"`, every other item `outcome: "not_applied"` and **no** stock changed; **When** the same request is replayed with the same `operationId`s but a new `Idempotency-Key`, **Then** each item answers `outcome: "replayed"` with the original `stock_after` and no stock changes again (operation IDs hold for 30 days); an `operationId` reused with a different product or delta → `422 operation_conflict`; duplicate `operationId`s inside one request, `delta` of `0`, non-integer, or `|delta| > 1,000,000`, more than 10,000 items, or an empty list → `400 validation_failed`.
9. **AS-51** (bulk stock above 100 items, asynchronous job) — **Given** 250 items, **When** `POST /v1/stock/bulk`, **Then** `202 {object:"bulk_stock_update", id:"bsu_…", status:"processing", total:250, chunks:3}` with `Location: /v1/stock/bulk/<id>`; the chunks of at most 100 items are applied independently (each atomic), and `GET /v1/stock/bulk/<id>` returns `{status: "processing"|"succeeded"|"partially_failed"|"failed", total, applied, replayed, failed, failures: [{operation_id, product_id, outcome}] (first 1,000), completed_chunks}`; with all chunks done and no failure `succeeded`; **When** one chunk is delivered twice (at-least-once queue), **Then** counters and stock change once; **When** a chunk message with an invalid payload arrives, **Then** it is dead-lettered with its reason, the job is not corrupted and no stock changes; **When** a worker crashes after applying a chunk but before recording it, **Then** the redelivered chunk answers `replayed` for each item and the counters end exact; another shop's job ID → `404`; job records are kept 7 days then purged; a job ID is never reused.
10. **AS-52** (a large file with unknown products becomes one job, replay-safe) — **Given** 10,000 items where 3 reference unknown products, **When** posted, **Then** the job accepts all items (`202`), the 3 appear as `not_found` failures with their `operation_id`, the others apply, and the final status is `partially_failed`; **When** the request is replayed with the same `Idempotency-Key`, **Then** the same job ID is returned and no second job exists.

---

### User Story 8 — Fair use: idempotency, rate limits and plan quotas (Priority: P1)

Retries are safe, one noisy key cannot starve the rest, and the plan's monthly allowance is enforced and visible in headers.

**Why this priority**: P0414 and OWASP API4; also required by the constitution (V.6) for every creating POST.

**Independent Test**: send the same `POST /v1/products` twice with one `Idempotency-Key`; exhaust a limit and read `Retry-After`.

**Acceptance Scenarios**:

1. **AS-53** (idempotency: replay, in flight, different body, missing, TTL) — **Given** `POST /v1/products` with `Idempotency-Key: k` and body `X`, **When** repeated with the same key and body, **Then** the stored `201` and body return with `Idempotent-Replayed: true` and exactly one product exists; **When** repeated while the first is still running, **Then** `409 request_in_progress` with `Retry-After: 1`; **When** repeated with body `Y`, **Then** `422 idempotency_key_reused`; **When** the header is missing on `POST /v1/products`, `POST /v1/stock/bulk` or `POST /v1/batch`, **Then** `422 idempotency_key_required` and nothing runs; a key longer than 255 characters or with control characters → `400`; **When** 24 h pass (clock), **Then** the key is forgotten and the same key creates again; a response with status `5xx` is **not** stored and the key is released so a retry re-executes; a `4xx` is stored and replayed; keys are scoped to the acting shop and route, so shops `A` and `B` (and `A1` and `A1t`) may use the same key text independently; `GET` and `PATCH` ignore the header.
2. **AS-54** (concurrent identical requests) — **Given** 10 parallel `POST /v1/products` with the same key and body (`Promise.all`, repeated 20 times), **Then** exactly 1 product exists, exactly 1 response is `201` with no replay header, and the other 9 are `201 replayed` or `409 request_in_progress`, never a second creation.
3. **AS-55** (per-key rate limit with headers) — **Given** the default policy (6,000 units per minute per key, token bucket), **When** key `A1` spends its allowance, **Then** the next call answers `429 rate_limited` with `Retry-After` (seconds until a unit is available), `RateLimit-Limit`, `RateLimit-Remaining: 0`, `RateLimit-Reset`; every authenticated response (`2xx`, `4xx`, `5xx`, `429`) carries those three headers with the current values; a different key of the same shop (`A2`) is unaffected (the limit is per key), and two server instances share one allowance; `Retry-After` respected → next call `200`.
4. **AS-56** (limiter outage fails open, visibly) — **Given** the rate-limit store is unreachable, **When** `A1` calls, **Then** `200` served, the `RateLimit-*` headers are omitted, counter `public_api_ratelimit_degraded_total` +1; each instance's local share of the allowance keeps bounding abuse meanwhile.
5. **AS-57** (monthly plan quota) — **Given** shop `A`'s plan allows `1,000` calls this month and `checkQuota('SHOP', A, 'apiCallsPerMonth')` returns `{allowed: false, used: 1000, limit: 1000, resetsAt: "2026-11-01T00:00:00.000Z"}`, **When** a live key calls, **Then** `429 quota_exceeded` with `Retry-After` = seconds until `resetsAt` (capped at 3,600 s, so clients re-check hourly) and the `detail` names the limit and the reset instant; the answer is cached per shop for 60 s (a plan upgrade is seen within 60 s); a test key is never blocked by the quota; **When** `checkQuota` rejects with `usage_unavailable`, **Then** the call is served (fail open), counter `public_api_quota_degraded_total` +1; a refused call is not billable (AS-64).

---

### User Story 9 — Request logs, usage and exact billing events (Priority: P1)

Every call leaves a record. A shop finds any request by its ID, sees which versions and routes are in use, and billing receives an exact count of billable calls.

**Why this priority**: observability per customer is a notes requirement, and the log drives deprecation and billing.

**Independent Test**: make a call, read `Request-Id` from the response, find that request in the shop's logs.

**Acceptance Scenarios**:

1. **AS-58** (one record per authenticated call) — **Given** keys of shop `A`, **When** a call is served (including `4xx`, `429`, `5xx` and `410`), **Then** exactly one event `api.request_logged` v1 `{requestId, clientRequestId?, shopId, keyId, livemode, version, method, route (the route template, e.g. "/v1/products/:id"), status (the status actually sent), durationMs, deprecated, errorCode?, batchOps?, idempotentReplay}` is produced with `aggregateId = shopId`; the response carries `Request-Id` equal to `requestId`; the record never contains the path's IDs, the query string, headers, bodies, the key or the client address; `shopId` is the **live** shop for both key modes (sandbox calls are flagged by `livemode: false`); unauthenticated calls produce no record (they are counted only, AS-14).
2. **AS-59** (request IDs) — **Given** any response, **When** inspected, **Then** `Request-Id` is present (on `2xx`, `4xx`, `5xx`, `401`, `404`, `429`), unique per request, and generated by the server; **When** the client sends `X-Request-Id: erp-123` (`^[A-Za-z0-9._-]{1,64}$`), **Then** it is echoed in `X-Client-Request-Id` and stored as `clientRequestId`; an invalid value is ignored and not echoed; the problem body's `requestId` equals `Request-Id`.
3. **AS-60** (search the logs) — **Given** 5 recorded calls of `A` and 1 of `B`, **When** `GET /api/shops/A/developers/logs?requestId=<id>`, **Then** exactly that record `{requestId, clientRequestId, keyId, livemode, version, method, route, status, durationMs, deprecated, errorCode, at}`; `?status=4xx|5xx|429|200`, `?route=`, `?keyId=`, `?livemode=false`, `?from=&to=` (ISO instants, at most 30 days back) filter; results are newest first with a cursor (`limit` 1–100, default 50) and a unique tiebreaker; `B`'s `requestId` searched under `A` returns an empty page (no existence signal); a `from` older than 30 days or `to` before `from` → `400`; unknown filter value → `400`; records older than 30 days are gone; requires `shop.read` (`403` without, `404` for non-members, `401` without a session); a manager of `A` can never read `B`'s logs by any parameter.
4. **AS-61** (logging never hurts the request) — **Given** the event bus is unavailable, **When** calls are served, **Then** they answer normally with no added latency beyond a bounded in-memory handover; records are retried with backoff from a bounded buffer (10,000 records); on overflow the oldest is dropped and `public_api_request_log_dropped_total` +1; after recovery buffered records arrive once each; the request path never waits for the bus.
5. **AS-62** (logged records are projected once) — **Given** the request-log consumer, **When** the same `api.request_logged` event is delivered twice (same `eventId`, and again with the same `requestId` under a new `eventId`), **Then** the search store holds one row; **When** a payload fails schema validation, **Then** it is dead-lettered with its reason and no row is written; a record for an unknown shop is stored (the log is owned here) and never rejected.
6. **AS-63** (usage report) — **Given** calls on 3 days at two versions and routes, **When** `GET /api/shops/A/developers/usage?days=30`, **Then** rows `{day, version, route, calls, errors, deprecatedCalls}` sorted by day descending then calls descending, errors being `5xx` only; `days` is `1…30`; `livemode` filter (`true` default, `false` for the sandbox); another shop's calls are not included; requires `shop.read`.
7. **AS-64** (exact usage events for billing) — **Given** live key calls of shop `A` in the UTC minute `12:00`: 7 served `2xx/3xx/4xx`, 1 `5xx`, 1 `429`, and a batch of 5 operations (served), **When** the minute is closed, **Then** exactly one event `usage.recorded` v1 `{metric: "api.calls", quantity: 12, ts: "2026-10-06T12:00:00.000Z"}` with `aggregateId = A` and an event ID derived from `(A, metric, minute, sequence 1)` is emitted — the `5xx` and `429` are not billable, a batch counts its operations, replays served from the idempotency store count as the request they replay (1); sandbox calls count `0`; **When** a request record is delivered twice (same `requestId`), **Then** the count is unchanged; **When** a late record for the already-closed minute arrives, **Then** one more event with sequence 2 and `quantity: 1` is emitted (never a negative or a re-sent total); **When** the metering consumer restarts mid-minute, **Then** totals are exact and no event ID is reused for different content; an invalid record is dead-lettered without effect; billing's total for a shop equals the number of billable calls exactly.

---

### User Story 10 — Every response is predictable, documented and safe (Priority: P2)

Errors always look the same, the contract is published and tested, limits on input are enforced, and each OWASP API risk has a named control.

**Why this priority**: P0519 and constitution V; they make the API trustworthy and reviewable.

**Independent Test**: fetch the OpenAPI description, call each documented error path, and compare bodies with the published problem schema.

**Acceptance Scenarios**:

1. **AS-65** (errors are problem details) — **Given** any failure of a public or dashboard route (`400, 401, 403, 404, 406, 409, 410, 412, 413, 415, 422, 428, 429, 500, 503`), **When** it is returned, **Then** the body is `application/problem+json` with `type` (a stable URL per `code`), `title`, `status`, `detail`, `instance`, `requestId`, and `code`; for `5xx` the `detail` is generic and no stack, SQL, hostname or upstream message appears; validation errors add `errors: [{field, code}]` with no echoed secret values; the documented set of codes is exactly the one in the contract.
2. **AS-66** (body limits and media types) — **Given** a `POST`, **When** the body is larger than 2 MiB → `413 payload_too_large`; the content type is not `application/json` → `415 unsupported_media_type`; the JSON is malformed → `400 validation_failed`; an `Accept` header that excludes JSON → `406`; **Then** none of them reaches a handler and each is logged as a record (AS-58) if the key was valid.
3. **AS-67** (the contract is published and tested) — **Given** the API, **When** the OpenAPI description is fetched, **Then** it validates as OpenAPI 3.1, lists every route, version header, scope (security requirement per operation), `Idempotency-Key`, `If-Match`, response codes (including `401, 403, 404, 429` and `410` where applicable), the deprecation flags (AS-36), the pagination and `fields`/`expand` parameters, and the problem schema; responses to the route tests of this spec parse against the matching schemas in the shared contracts package **for each supported version** (shape drift fails the test); the description is served without authentication and contains no real key.
4. **AS-68** (OWASP API Top 10 mapping is published and complete) — **Given** the developer security note, **When** inspected, **Then** it maps each of the ten 2023 risks to the control that addresses it and to the acceptance scenario IDs of this spec that prove it (API1 object-level → AS-16; API2 authentication → AS-13, AS-14, AS-20; API3 property-level → AS-28, AS-38, AS-42; API4 resource consumption → AS-44, AS-48, AS-55, AS-57, AS-66; API5 function-level → AS-15, AS-45; API6 sensitive business flows → AS-05, AS-53; API7 SSRF → "no feature fetches a client-supplied URL", enforced by AS-44's path rule; API8 misconfiguration → AS-65, AS-66, AS-69; API9 inventory → AS-32–AS-36, AS-67; API10 unsafe consumption → AS-50, AS-51 (all upstream results validated)); every referenced scenario ID exists in this spec, and every row names an owner.
5. **AS-69** (safe transport defaults) — **Given** any public response, **When** inspected, **Then** `Cache-Control: no-store` on every authenticated response, `X-Content-Type-Options: nosniff`, no `Server`/framework banner, no CORS allow headers (the API is server-to-server; a browser preflight is answered without `Access-Control-Allow-Origin`), and cookies are neither read nor set.
6. **AS-70** (domain boundaries hold) — **Given** the finished capability, **When** `pnpm --dir packages/backend check:table-ownership --strict` and `pnpm check:boundaries` run, **Then** zero `developer-platform` findings for this capability's code: no query on `Product`, `Shop`, `ShopMembership`, `ShopOrder`, `BisOrder`, `BisOrderItem`; no import of another domain's models or internals; no foreign key from this domain's tables to another owner's table; the domain entry point exports only Nest modules, the version service, DTO types and event contracts; every table of this capability has exactly one registry entry owned by `domain:developer-platform`.
7. **AS-71** (graceful shutdown and readiness) — **Given** a public API instance receiving a termination signal, **When** it shuts down, **Then** it fails readiness first, finishes in-flight requests (including batches, up to their budget), flushes the pending request records and the open usage minute, and only then closes its pools; a call during shutdown drain is not accepted by that instance.

### Edge Cases

- A key whose creator left the shop keeps working; the creator's ID stays on the key (AS-01); there is no automatic revoke (Assumptions).
- A key that is both rotating and then revoked: revoked wins, the successor is untouched (AS-08).
- Two keys with the same name are allowed; names are labels, never identifiers.
- A request with two `Authorization` headers or two `Marketplace-Version` headers is refused (`401` / `400 invalid_version`).
- A `GET` with a body, or with `Idempotency-Key`, ignores them; a `HEAD` is treated as `GET` and never changes state.
- A product list for a shop with no products is `200 {object: "list", data: [], has_more: false, next_cursor: null}`.
- A cursor from an older version of the API (still valid because cursors are version-independent) works at any version.
- An order whose status is a value this version never listed is passed through; clients are told to tolerate it.
- Clock skew: keys use the server clock only; `expiresAt` boundaries are inclusive of the second named (AS-10); the sunset is evaluated at the instant of the request.
- A replayed request still spends its rate-limit units (it is a request); only the work is skipped (AS-47, AS-53).
- A very large `expand`/`fields` list is refused at 3 `expand` values or when a `fields` name is unknown (AS-38).
- The sandbox shop's own limits (product count) follow S05's plan limits applied to the sandbox like any shop; it has no plan.

## Requirements *(mandatory)*

### Functional Requirements

**API keys (US1, US2)**

- **FR-001**: A manager of a shop (`shop.manage`) MUST be able to create a key with a name (1–60 characters), at least one distinct scope from the four defined scopes, a mode (live or test), and an optional expiry in the future and within 365 days (AS-01, AS-02).
- **FR-002**: A key MUST have the form `sk_live_|sk_test_<12-char public prefix>_<32-char secret>`, generated from a cryptographically secure source without modulo bias; the full key is returned exactly once, in the creation or rotation response, with `Cache-Control: no-store` (AS-01, AS-20).
- **FR-003**: Only a keyed one-way hash of the secret MUST be stored; the key-hashing secret MUST be configured separately from every other secret, startup MUST fail without it, and a previous value MAY be configured to allow rotation of that secret with re-hash on use (AS-20, AS-21).
- **FR-004**: Verification MUST locate the key by its public prefix, compare in constant time, reject a mode that differs from the stored mode, and give the same `401 invalid_api_key` for every refusal reason (AS-13, AS-25).
- **FR-005**: A key MUST have exactly one lifecycle status derived from its state: `active`, `rotating` (has a successor and a scheduled expiry), `expired`, `revoked`; transitions are: `active → rotating`, `active|rotating → revoked`, `rotating|active → expired` by time only; every other transition (rotate a revoked, expired or rotating key) MUST answer `409` with `key_revoked`, `key_expired` or `key_already_rotating`, conditionally in the store so concurrent requests have exactly one winner (AS-06, AS-07).
- **FR-006**: Rotation MUST create a successor with the same scopes and mode, and keep the old key valid for an overlap (default 24 h, `0…168` h, whole hours), after which it expires (AS-06).
- **FR-007**: Revocation MUST be idempotent and effective for every instance at once; no call that starts after the revoke returns may succeed, including a concurrently racing cache fill (AS-08, AS-09).
- **FR-008**: Key verification on the hot path MUST NOT read the system of record when the key is cached; the cache stores the hash and key metadata only (never "valid"), and holds an entry for at most 60 seconds (AS-18, AS-09).
- **FR-009**: `lastUsedAt` MUST be recorded write-behind with at most 1 minute of delay, never moving backwards, and without affecting the request when the record is lost (AS-11).
- **FR-010**: A shop MUST have at most 25 active-or-rotating keys; the limit MUST be enforced by the store so concurrent creations cannot exceed it (AS-05).
- **FR-011**: Key routes (create, list, rotate, revoke) and the version-pin route MUST be sensitive routes (a logged-out session is refused at once); creating or rotating a live key MUST require a session whose `amr` includes `mfa` (AS-04).
- **FR-012**: Each key lifecycle change MUST emit exactly one event in the same commit as the change: `developer_platform.api_key_created`, `…api_key_rotated`, `…api_key_revoked`; events never contain the secret or the hash (AS-01, AS-06, AS-08).
- **FR-013**: The capability MUST react to `tenancy.shop_deleted` by revoking all the shop's keys once, and to `tenancy.shop_status_changed` by refusing calls according to the new status on every instance; both consumers MUST be idempotent, validate their payload, and dead-letter invalid ones (AS-12, AS-17).
- **FR-014**: Authentication and every shop-scoped lookup MUST take the shop only from the key (never from a path, header or body the client controls); the dashboard routes take the shop from the path and S03's membership check (AS-16, AS-03).

**Scopes, tenant isolation, and the shop status gate (US2)**

- **FR-015**: Each public route MUST require its declared scope (`products:read`, `products:write`, `stock:write`, `orders:read`), checked after authentication and before any work, answering `403 insufficient_scope` with the required scope names (AS-15).
- **FR-016**: Every lookup of a shop-owned record MUST include the key's shop in the same query or service call; another shop's record, job or batch operation MUST answer `404 resource_missing` indistinguishable from an unknown ID, and MUST NOT be changed (AS-16).
- **FR-017**: A call by a key of a suspended shop MUST answer `403 shop_suspended` and of an offboarding shop `409 shop_offboarding`, for reads and writes, with a staleness of at most 60 s without events and immediately with them (AS-17).
- **FR-018**: Failed authentications MUST be throttled per client address (30 per minute), counted by reason, and never written to a shop's request log (AS-14).
- **FR-019**: When the key store is unavailable and the key is not cached the call MUST answer `503 service_unavailable` (never `401`); when only the fast store is unavailable the system of record MUST be used (AS-18).
- **FR-020**: Secrets (keys, secrets, `Authorization` values) MUST NOT appear in logs, request records, events, errors, metric labels or traces (AS-19).

**Sandbox (US3)**

- **FR-021**: A test key MUST act only on its shop's sandbox shop, obtained and created idempotently through the tenancy capability's provisioning service; a live key MUST act only on the live shop; the two data sets are invisible to each other and the sandbox data is invisible to buyers (AS-22, AS-23, AS-25).
- **FR-022**: Every public resource MUST carry `livemode` matching the key's mode (AS-22).
- **FR-023**: Sandbox calls MUST NOT produce usage events, MUST NOT count toward quotas, MUST be flagged in request records, and the sandbox MUST expose no orders (AS-24).

**Versions (US4)**

- **FR-024**: Versions MUST be dates registered in one ordered registry with a lifecycle (`supported`, `deprecated` with sunset, `retired`); the latest is never retired (AS-31).
- **FR-025**: The shop MUST be pinned to the latest version when its first key is created (once, atomically); a per-request `Marketplace-Version` header overrides the pin for that request only; the version used is echoed in `Marketplace-Version` on every authenticated response; an unsupported or malformed value answers `400 invalid_version` (AS-26, AS-27).
- **FR-026**: Handlers MUST produce and accept only the latest shape; transformers registered per version change MUST downgrade responses and upgrade requests to the requested version, for products, orders and lists; adding a version MUST NOT change any handler (AS-28, AS-29, AS-31).
- **FR-027**: Sparse fieldsets and `expand` MUST be evaluated against the requested version's field names (AS-29, AS-38).
- **FR-028**: A manager MUST be able to read and change the shop's pin to any non-retired supported version; a change MUST take effect on every instance within 5 s, be recorded as an event, and be a sensitive route (AS-30).
- **FR-029**: Within a version, changes MUST be additive only; the contract check MUST fail on removal or change of a field of an existing version (AS-36, AS-67).

**Deprecation (US5)**

- **FR-030**: A registry of deprecated routes and versions (`deprecatedAt`, `sunset`, replacement, optional brownout windows) MUST drive the headers `Deprecation: @<unix seconds>` (RFC 9745), `Sunset: <HTTP-date>` (RFC 8594) and `Link` with `rel="deprecation"` and `rel="successor-version"` on every response of a deprecated route or version, including error responses (AS-32, AS-33).
- **FR-031**: The registry MUST be validated: a sunset earlier than 6 months after `deprecatedAt` fails startup (security-driven removals use an explicit flag with a minimum of 30 days) (AS-31).
- **FR-032**: At or after the sunset the route or version MUST answer `410 Gone` problem (`endpoint_retired` / `version_retired`) with the replacement named; inside a brownout window it MUST answer `410 endpoint_brownout` with `Retry-After`; outside, normal service (AS-34).
- **FR-033**: Every call to a deprecated route or version MUST be flagged in its request record and counted by `public_api_deprecated_calls_total{route,version}`; the usage report MUST list per version, route and key the calls and last call (AS-35, AS-63).
- **FR-034**: The OpenAPI description MUST mark deprecated routes with their sunset and replacement and MUST list no deprecation headers for routes outside the registry (AS-36).

**Resources (US6)**

- **FR-035**: The public API MUST offer: `GET|POST /v1/products`, `GET|PATCH /v1/products/:id`, `GET /v1/stock/:productId`, `POST /v1/stock/bulk`, `GET /v1/stock/bulk/:jobId`, `GET /v1/orders`, `GET /v1/orders/:id`, `POST /v1/batch`, and the deprecated `GET /v1/products/:id/stock`; all other methods and paths answer `404` or `405` as problem details.
- **FR-036**: Lists MUST use keyset pagination with an opaque cursor, a deterministic order ending in a unique tiebreaker, `limit` `1…100` (default 20), strict validation (no silent clamping), and no skipped or repeated rows under concurrent inserts (AS-37).
- **FR-037**: `fields` and `expand` MUST be allowlists: `expand` accepts only `shop`, depth 1, at most 3 values; an expansion MUST use a batch lookup for the whole page (AS-38).
- **FR-038**: Products MUST be created, updated and read only through the catalog capability's exported services (R1); orders only through the order capability's exported service (R1); shops only through the tenancy capability's exported services (R1); no query touches another domain's table (AS-39, AS-42, AS-70).
- **FR-039**: Money MUST be integer minor units in `{amount, currency}` (latest version) with the currency taken from the product, never hard-coded; a price of `0`, a negative, a fractional or above-maximum amount, or a different currency MUST be refused (AS-39).
- **FR-040**: Product updates MUST require `If-Match` with the product's version (`428` if absent, `412` if stale); product responses MUST carry `ETag` and `version` (AS-40).
- **FR-041**: Orders MUST expose only the key's shop's subtotal and lines, and no buyer-identifying or payment data (AS-42).
- **FR-042**: Every response body MUST be built by an explicit public DTO; no internal model, internal ID not meant for clients, hash or secret may be serialized (AS-42, AS-65).

**Batch and bulk (US7)**

- **FR-043**: `POST /v1/batch` MUST accept 1–50 operations of the batchable set, run them in order, return per-operation `{status, body, headers?}`, apply each operation's scope, tenant and idempotency rules, and never run as one transaction (AS-43, AS-45, AS-46, AS-47).
- **FR-044**: A batch MUST be validated as a whole before any operation runs; invalid operations that are individually valid but not batchable MUST answer a per-operation `422 unsupported_operation` (AS-44).
- **FR-045**: A batch MUST have a 10 s budget; operations not started by then MUST answer `503 batch_deadline_exceeded` with `retryable: true` and MUST NOT run; no running operation is interrupted (AS-49).
- **FR-046**: Stock MUST be written only as deltas with an operation ID (1–128 characters, unique in a request, `delta` a non-zero integer with `|delta| ≤ 1,000,000`), through the catalog capability's stock service; ≤ 100 items MUST be applied synchronously, all-or-nothing; more (up to 10,000) MUST become a job processed in chunks of 100, each chunk atomic and idempotent (AS-50, AS-51, AS-52).
- **FR-047**: A bulk job's state (counts, per-chunk completion, failures) MUST be stored durably in this domain's own store, updated atomically and idempotently per chunk, scoped to the shop, kept 7 days, and redelivery or a crash MUST NOT double count (AS-51).
- **FR-048**: Missing or foreign products in a bulk request MUST be determined by one batch lookup scoped to the shop and reported per item as `not_found` without failing the rest (AS-50, AS-52).

**Fair use (US8)**

- **FR-049**: Every `POST` that creates (`/v1/products`, `/v1/stock/bulk`, `/v1/batch`) MUST require `Idempotency-Key` (`422 idempotency_key_required` if absent); a replay MUST return the stored status and body with `Idempotent-Replayed: true`; an in-flight duplicate MUST answer `409 request_in_progress`; a different body MUST answer `422 idempotency_key_reused`; keys live 24 h and are scoped to the acting shop and route; a `5xx` is never stored (AS-53, AS-54).
- **FR-050**: Concurrent identical requests MUST produce exactly one effect (AS-54).
- **FR-051**: Each key MUST be rate-limited by a token bucket (6,000 units per minute by default, shared across instances); a batch costs its operation count, bulk stock `⌈items ÷ 100⌉`; every authenticated response MUST carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and a `429` MUST carry `Retry-After` (AS-48, AS-55).
- **FR-052**: When the rate-limit store is unavailable the API MUST fail open, omit the headers and count it (AS-56).
- **FR-053**: Before serving a live-key call the monthly quota MUST be checked through the billing capability's exported `checkQuota` (answer cached 60 s per shop); a refusal MUST answer `429 quota_exceeded` with `Retry-After` (capped at 3,600 s); `usage_unavailable` MUST fail open and be counted; test keys are never limited by the quota (AS-57).

**Request logs and usage (US9)**

- **FR-054**: Every authenticated call MUST yield exactly one `api.request_logged` v1 record with the fields in AS-58, produced without delaying the response, with bounded retry and a counted drop on overflow (AS-58, AS-61).
- **FR-055**: Every response MUST carry a server-generated unique `Request-Id`; a valid client `X-Request-Id` MUST be echoed in `X-Client-Request-Id` and stored (AS-59).
- **FR-056**: Request records MUST be stored for 30 days, searchable per shop by request ID and the filters of AS-60 with keyset pagination, projected idempotently (once per `requestId`) and with invalid payloads dead-lettered (AS-60, AS-62).
- **FR-057**: The usage report MUST aggregate per day, version and route (calls, errors, deprecated calls) for the shop, for 1–30 days (AS-63).
- **FR-058**: Billable usage MUST be derived from request records, deduplicated by `requestId`, bucketed per shop and UTC minute, and emitted as `usage.recorded` v1 `{metric: "api.calls", quantity ≥ 1, ts}` with `aggregateId = shopId` and a deterministic event ID per `(shop, metric, minute, sequence)`; billable = served live calls with status below 500 and not `429`, cost-weighted (AS-64).

**Cross-cutting (US10)**

- **FR-059**: Every error MUST be a problem document with the fields and stable codes of AS-65; `5xx` details are generic.
- **FR-060**: Bodies MUST be limited to 2 MiB; content types, `Accept`, JSON syntax and unknown properties MUST be refused before reaching a handler (AS-66).
- **FR-061**: The OpenAPI description and per-version contract schemas MUST be the source of truth and be checked against real responses (AS-67).
- **FR-062**: The OWASP API Security Top 10 (2023) mapping MUST be published with the scenario IDs that prove each control (AS-68).
- **FR-063**: Authenticated responses MUST be non-cacheable and carry safe transport headers; no CORS is granted (AS-69).
- **FR-064**: This capability MUST own exactly its tables (`ApiKey`, `ShopApiSettings`, the bulk-job tables) with no foreign key to another owner's table, use no other domain's model or table, and expose only Nest modules, the version service, DTOs and event contracts from its entry point (AS-70).
- **FR-065**: All time MUST come from the injected clock; the service MUST shut down gracefully as in AS-71.
- **FR-066**: Every consumer of this capability (shop lifecycle, request-log projector, usage metering, bulk chunk worker) MUST be idempotent and validate its payload, with a duplicate-delivery test and an invalid-payload test (AS-12, AS-51, AS-62, AS-64).

### Defaults

| Setting | Default |
|---|---|
| Key name length | 1–60 characters |
| Key expiry | optional; future; ≤ 365 days |
| Active-or-rotating keys per shop | 25 |
| Rotation overlap | 24 h (`0…168` whole hours) |
| Key cache TTL; shop-status staleness without events | 60 s |
| Version-pin propagation | ≤ 5 s |
| Rate limit | 6,000 units / minute / key; auth failures 30 / minute / address |
| Page size | default 20, `1…100` |
| `expand` | `shop` only; ≤ 3 values; depth 1 |
| Batch | 1–50 operations; 10 s budget; 2 MiB body |
| Bulk stock | ≤ 10,000 items; sync ≤ 100; chunk 100; `|delta| ≤ 1,000,000`; job kept 7 days; operation IDs held 30 days (by the stock service) |
| Idempotency key | 1–255 characters; TTL 24 h |
| Quota answer cache; quota `Retry-After` cap | 60 s; 3,600 s |
| Request-log retention; search window | 30 days |
| Request-log buffer when the bus is down | 10,000 records |
| Usage bucket | UTC minute |
| Minimum deprecation window | 6 months (security removals ≥ 30 days) |
| Supported versions | `2026-01-15` (deprecated 2026-10-01, sunset 2027-04-01), `2026-10-01` (latest) |
| Deprecated route | `GET /v1/products/:id/stock` (2026-10-01 → 2027-04-01, replacement `GET /v1/stock/{productId}`) |

### Key Entities

- **API key**: `{id, shopId, public prefix (unique), keyed hash of the secret, name, scopes, mode (live or test), createdBy (user ID, audit only), expiresAt?, rotation successor?, revokedAt?, lastUsedAt?, createdAt}`; status is derived (`active`, `rotating`, `expired`, `revoked`). Owned here.
- **Shop API settings**: `{shopId, pinnedVersion, pinnedAt, updatedAt}`; one per shop. Owned here.
- **Bulk stock job**: `{id, shopId, total, chunks, completedChunks, applied, replayed, failed, failures (first 1,000), status, createdAt, expiresAt}` and one completion marker per chunk. Owned here.
- **Version registry / deprecation registry** (code-defined, not stored): versions with lifecycle, change transformers, deprecated routes with sunset, replacement and brownout windows.
- **Request record** (event and searchable log row): see AS-58. Owned here (the request-log store).
- **Usage bucket event**: `usage.recorded` as in FR-058.
- **Public resources** (not stored here): product, stock, order, list, batch result, bulk job; always mapped from the owning capability's DTOs.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a revoke returns, 100 % of later calls with that key are refused on every instance, with no exception in 20 repeated concurrency runs (AS-08, AS-09).
- **SC-002**: Across every category of invalid credential, 100 % of refusals are indistinguishable (same status, body shape and headers), and 0 occurrences of a plaintext key appear in logs, events, errors or metrics in a full scripted run (AS-13, AS-19).
- **SC-003**: Data of one shop is returned to another shop's key in 0 of the cross-tenant probes (every read, write, list, bulk and batch route), and the answer is `404` in 100 % of them (AS-16).
- **SC-004**: Sandbox and live data are disjoint: 0 sandbox rows visible to a live key or a buyer; 0 live rows visible to a test key; the sandbox shop is created exactly once under 10 simultaneous first calls (AS-22, AS-23).
- **SC-005**: A shop pinned to a version sees the same response shape for 100 % of calls after a new version ships, and every supported version's responses validate against its published schema (AS-26, AS-28, AS-67).
- **SC-006**: 100 % of calls to a deprecated route or version carry the three announcement headers, and after sunset 100 % return `410` with the replacement named (AS-32–AS-34).
- **SC-007**: A retried creating request never creates a second record: 0 duplicates in 200 concurrent same-key requests (AS-54); bulk stock counted twice under duplicate delivery changes stock 0 extra times (AS-51).
- **SC-008**: Billed usage for a shop equals its number of billable calls exactly (0 difference) under duplicate delivery, restarts and late records (AS-64).
- **SC-009**: A shop finds any request of the last 30 days by its ID in one query, and the record exists for 100 % of authenticated calls when the event bus is healthy (AS-58, AS-60).
- **SC-010**: At 30,000 requests per second across 100,000 keys, 99 % of authenticated read calls finish in under 150 ms, per-key limits hold across instances, and logging or metering failures add no latency (load script, ops artifact; AS-55, AS-61).
- **SC-011**: The domain has 0 findings in the table-ownership check and the boundary check for this capability's code, and 0 foreign keys to another owner's tables (AS-70).
- **SC-012**: Each of the ten OWASP API risks has a named control and at least one acceptance scenario that exists in this spec (AS-68).

## Assumptions

- **Keys are shop-owned**: they survive the creator leaving the shop; automatic revoke on member removal is not done (Stripe-style behaviour), and the manager can revoke at any time. Leak reporting by secret scanners, per-key IP allow-lists and OAuth apps are future capabilities.
- **A fast one-way hash is right for the key secret** (high-entropy random secret, hot path), as the notes state; the keyed hash uses a dedicated secret, which can be rotated with a previous-value fallback.
- **Stock writes are deltas**, as the stock service offers; an ERP that holds an absolute count sends the difference it computed. `PATCH` may set absolute stock, but only under `If-Match`.
- **Currency is the platform currency** of S05; the `currency` in requests must equal it. Money is never floating-point.
- **Products list reads the catalog's database through R1** (`listByShop`), not an R3 read model, because the list is scoped to one shop (no cross-domain filter or sort); revisit if the load test (SC-010) shows the catalog cannot take it.
- **Order statuses are the order capability's** and may grow; clients tolerate unknown values.
- **Sandbox limits** are those of any shop; no sandbox reset, no sandbox orders, no sandbox webhooks (S43).
- **Brownouts** are registered in code with the deprecation; scheduling tooling and announcements (email, banners) belong to a developer-relations process outside this system.
- **Quota semantics**: the free tier has quotas, not overage billing (S18); this capability only refuses the call when the billing capability says the quota is spent, and fails open when it cannot ask.
- **Usage granularity** is one event per shop per UTC minute with a sequence for late records; billing de-duplicates by event ID.
- **Request logs are best-effort**; billing's usage events are exact because they come from the deduplicated record stream with a deterministic identity.
- **The platform's request-ID middleware** generates `requestId`; this capability does not invent its own.
- **The dashboard routes** keep their path (`/api/shops/:shopId/developers/…`) and authentication (session); only the public routes use keys.
- **Webhook payload versions** (S43) read the supported-version list and each endpoint's pin from this capability's version service.

## Cross-capability contracts

**Provides**

- **Public HTTP API** (apps: `public-api`; key-authenticated; no prefix other than `/v1`; OpenAPI at the documentation route): the routes of FR-035 with the shapes in AS-28, AS-38–AS-42, AS-50, AS-51; headers `Marketplace-Version`, `Idempotency-Key`, `If-Match`, `ETag`, `Request-Id`, `X-Request-Id`/`X-Client-Request-Id`, `RateLimit-*`, `Retry-After`, `Deprecation`, `Sunset`, `Link`, `Idempotent-Replayed`. Consumers: external integrators; **W04** documents the base URL and the shown-once key.
- **Dashboard HTTP API** (core; session + `ShopScoped`; path prefix `/api/shops/:shopId/developers`): `POST keys` (`shop.manage`, sensitive; live keys need `mfa`) → `201 {id, key, prefix, name, scopes, livemode, status, expiresAt, createdAt}`; `GET keys` → page of `{id, prefix, name, scopes, livemode, status, expiresAt, lastUsedAt, createdBy, createdAt, successorId?}` (`shop.manage`); `POST keys/:keyId/rotate {overlapHours?}` → `201` (same shape as create plus `previousExpiresAt`); `DELETE keys/:keyId` → `204`; `GET api-version` → `{version, pinnedAt, supported: [{version, status, sunset?}], latest}`; `PUT api-version {version}` → `200 {version, previousVersion, pinnedAt}` (`shop.manage`, sensitive); `GET logs?requestId&status&route&keyId&livemode&from&to&limit&cursor` → `{items, nextCursor}` (`shop.read`); `GET usage?days&livemode&deprecated` (`shop.read`). Consumer: **W04** (developer settings; webhook routes are S43's).
- **Events** (outbox → topic keyed by aggregate ID; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`):
  - `api.request_logged` v1 `{requestId, clientRequestId?, shopId, keyId, livemode, version, method, route, status, durationMs, deprecated, errorCode?, batchOps?, idempotentReplay}`, `aggregateId = shopId`; at least once; no PII. Consumers: this capability's own projector and usage metering (no other).
  - `usage.recorded` v1 `{metric: "api.calls", quantity: integer ≥ 1, ts: ISO instant}`, `aggregateId = shopId`, deterministic `eventId` per `(shopId, metric, minute, sequence)`; at least once. **Consumer: S18** (usage store; matches S18's stated shape).
  - `developer_platform.api_key_created|api_key_rotated|api_key_revoked` v1 `{keyId, shopId, prefix, livemode, scopes, actorId?, successorId?, reason?}` (reason on revoke: `manual | shop_deleted | rotation_expired`), `aggregateId = keyId`; never a secret or hash. Optional consumers: S28 (security notices), audit.
  - `developer_platform.api_version_pinned` v1 `{shopId, version, previousVersion, actorId}`, `aggregateId = shopId`.
- **Exported service (R1)** `ApiVersionService`: `supportedVersions(): readonly ApiVersion[]`, `latestVersion(): ApiVersion`, `isSupported(version: string): boolean`, `getPinnedVersions(shopIds: ShopId[]): Promise<Map<ShopId, ApiVersion>>` (≤ 500; the latest for an unpinned shop). **Consumer: S43** (pinning a webhook endpoint's payload version). Nothing else is exported besides the Nest modules (`DevelopersModule`, `PublicApiModule`, `PublicApiWorkerModule`, `PublicApiProjectorModule`) and DTO types.
- **Rate-limit policies declared** (in S50's registry): `public-api.default` (token bucket, 6,000 / 60 s, key `apiKey`, fail open, with request cost) and `public-api.auth-failure.ip` (30 / 60 s, key `ip`, fail closed).
- **Scheduled jobs** (S49): `public-api.flush-key-usage` (every minute, single run), `public-api.purge-bulk-jobs` (daily).

**Requires**

- **S01**: `Firewall({sensitive: true})` on the key and pin routes; `@User()` giving `AuthenticatedUser = {id, role, sessionId, amr: string[]}`; the constant `SecretBox` is **not** used here (keys are hashed, not encrypted).
- **S02**: `amr` contains `mfa` after a second factor (used by FR-011).
- **S03**: `ShopScoped(permission)` with `shop.manage` and `shop.read`, the status gate (`403 shop_suspended`, `409 shop_offboarding`), `404` for non-members; `ShopQueryService.getShopsByIds(ids ≤ 500): Map<ShopId, ShopSummaryDto>` with `{id, slug, name, status, isSandbox, sandboxOf}` (R1; for status and `expand=shop`); `ShopProvisioningService.ensureSandboxShop(liveShopId): ShopSummaryDto` (R1, idempotent and safe under concurrency); events `tenancy.shop_status_changed` v1 `{shopId, from, to, reason?, shopVersion}` and `tenancy.shop_deleted` v1 `{shopId}`. `TenancyModule` loaded in every app that hosts this capability.
- **S05**: `ProductQueryService.getProductsByIds(ids ≤ 500, {shopId}): Map<ProductId, ProductDto>`; `ProductCommandService.create(shopId, actorId, input)`, `update(shopId, productId, input & {expectedVersion})`, `listByShop(shopId, {limit, cursor})`, `getForShop(shopId, productId)`, throwing `ProductNotFoundError`, `VersionConflictError`, `ProductArchivedError`, `ShopNotActiveError`; `ProductStockService.applyStockDelta(ops ≤ 100): ApplyStockResult` (all-or-nothing, never below zero, idempotent per `operationId` for 30 days; throws `StockOperationConflictError`); `ProductDto` with `priceMinor, currency, quantity, status, version, isSandbox, createdAt, updatedAt`. `CatalogModule` loaded in the public API and worker apps. This capability maps `priceMinor → price.amount`, `quantity → stock`.
- **S10**: `OrderQueryService.getOrdersForShop(shopId, {status?, limit ≤ 100, cursor?}): {items: ShopOrderDto[], nextCursor}`, `getOrderLines(orderIds ≤ 500): Map<OrderId, OrderLineDto[]>` (one query), and — **new, asked for in `questions.md`** — `getShopOrder(shopId, shopOrderId): Promise<ShopOrderDto | null>` (shop-scoped; `null` for another shop's order); `ShopOrderDto` carries the shop-order ID, status, the shop's `subtotalMinor`, `currency`, `createdAt`, and lines `{productId, quantity, unitPriceMinor}`.
- **S18**: `checkQuota('SHOP', shopId, 'apiCallsPerMonth'): {allowed, used, limit, resetsAt}` (rejects `usage_unavailable`); consumes `usage.recorded` as specified above.
- **S43 / shared idempotency capability (P0414)**: an idempotency store with claim (in flight), stored response with TTL, request fingerprint, and release on `5xx`, usable by a controller for a route and an acting-shop scope.
- **S49**: single-run scheduled jobs. **S50**: the policies above, with `apiKey` and `ip` key types and a **per-request cost** (units) and `RateLimit-*` header output. **S52**: `getOrLoad` with single-flight, negative entries, `invalidate` with cross-instance broadcast. **S53**: `outbox.append` inside the domain's transaction, consumer runtime (envelope check, zod validation, inbox/dedupe, DLQ), SQS queue port with at-least-once delivery. **S54**: problem+json filter with `code`, request context with `requestId`, config validation, the clock, metrics registry, graceful shutdown.
- **Infrastructure clients**: request-log store client (parameterised queries, timeout, durable inserts), event bus producer with timeout.
