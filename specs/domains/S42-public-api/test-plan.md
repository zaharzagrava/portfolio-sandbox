# Test Plan: S42 — Seller public API (domain `developer-platform`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (71 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. A unit entry proves a pure rule table; an API e2e entry of the same row (when both appear) proves one wired case through the real modules, never the table again.

- API e2e files live in `packages/backend/libs/domains/developer-platform/` and boot the real `PublicApiModule`, `DevelopersModule`, `PublicApiWorkerModule` and `PublicApiProjectorModule` (plus the tenancy, catalog, orders, billing, identity and rate-limit modules they import) with the production global prefix settings of each app (`/v1` without prefix for the public API; `/api` for the dashboard), `ValidationPipe`, problem+json filter and interceptors, called through `supertest`. Each file's top-level `describe` names its feature:
  - `api-keys.e2e-spec.ts` — describe "Developer platform: API key lifecycle (dashboard)"
  - `public-api-auth.e2e-spec.ts` — describe "Public API: authentication, scopes and tenant isolation"
  - `public-api-sandbox.e2e-spec.ts` — describe "Public API: sandbox"
  - `public-api-versions.e2e-spec.ts` — describe "Public API: date-pinned versions and deprecation"
  - `public-api-resources.e2e-spec.ts` — describe "Public API: products, stock and orders"
  - `public-api-batch.e2e-spec.ts` — describe "Public API: batch and bulk stock" (includes the VII.4 duplicate-chunk and invalid-chunk tests of the bulk worker)
  - `public-api-limits.e2e-spec.ts` — describe "Public API: idempotency, rate limits and quotas"
  - `public-api-logs-usage.e2e-spec.ts` — describe "Public API: request logs and usage report"
  - `developer-platform-consumers.e2e-spec.ts` — describe "Developer platform: consumers (shop lifecycle, request-log projector, usage metering)" (the VII.4 duplicate-delivery and invalid-payload tests of each)
  - `public-api-contract.e2e-spec.ts` — describe "Public API: problem details, OpenAPI, contracts and transport defaults"
  - The existing `public-api.e2e-spec.ts` (6 tests) is split into these files and deleted: its tests move to AS-16/AS-13, AS-15, AS-28, AS-32, AS-53 and AS-22 (and the bulk/cursor test to AS-37/AS-50), and are rewritten (no `Shop` model injection, no `ShopApiSettings` inserts, no mocked Kafka producer, no fixed price/stock shapes of the old contract).
- Users, shops, memberships and sessions are seeded only through shared fixture helpers and the exported services of identity (`SessionIssuer`) and tenancy; no spec injects `UserModel`, `ShopModel` or `ShopMembershipModel` (D-7). Products and orders are seeded through the catalog's and orders' exported services. Real engines: Postgres, Redis, the request-log store, the event bus and SQS stand-ins, with real migrations. Only system edges are faked: identity token verification, third-party HTTP, and the clock (frozen at `2026-10-06T12:00:00Z`).
- Source events (`tenancy.shop_deleted`, `tenancy.shop_status_changed`, `api.request_logged`) and queue messages are delivered through the consumer entry points the framework (S53) calls, with schema-valid envelopes built from the `packages/contracts` event schemas.
- Every e2e test asserts the response body **and** the persisted state (key rows, pin rows, job rows, outbox rows, emitted events, request-log rows, counters). Waiting uses `waitFor` on a condition, never a fixed sleep.
- Responses are parsed with the matching `packages/contracts` schema for **each supported version** (VII.6).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`) and exist only for pure logic (VII.5): `api-key-format.spec.ts` (extends the existing file), `key-status.spec.ts` (lifecycle state machine and `assertNever`), `versioning.spec.ts` (transformers, resolution rule, registry validation), `deprecation.spec.ts` (header values, window evaluation, minimum window), `sparse-fields.spec.ts` (`fields` / `expand` parsing), `bulk-chunking.spec.ts` (chunk split and counters), `usage-bucket.spec.ts` (minute bucketing, billable rule, deterministic event ID); `fast-check` properties for the downgrade/upgrade round trip (AS-31) and for the usage bucket (sum of buckets equals number of billable records under any duplication and ordering).
- UI journeys (Playwright) are owned by **W04** in `packages/web/e2e/developers.spec.ts`, happy path only: a manager with a second-factor session opens developer settings, creates a live key (the full key is shown once with a copy action and is gone after closing), rotates it (both rows show; the old one `rotating`), revokes it (row shows `revoked`), switches the pinned API version and sees it after reload. They never re-test an edge case already proven here.
- Static gates (VII.1, IX.5, X.6): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-70); `pnpm check:module-graph`; `pnpm check:model-registry`.
- Gate 9 (VII.9) fallback/degradation tests that force the fault: AS-18 (fast store down; system of record down), AS-49 (batch budget exhausted), AS-56 (limiter store down), AS-57 (usage store rejects `usage_unavailable`), AS-61 (event bus down).
- Concurrency tests use `Promise.all` and assert that exactly the allowed number succeed and the invariant holds (VII.3), repeated at least 20 times in one test: AS-05, AS-07, AS-09, AS-23, AS-26, AS-30, AS-40, AS-54.
- Async consumers (VII.4): shop-lifecycle consumer (AS-12 duplicate and invalid), request-log projector (AS-62 duplicate and invalid), usage metering (AS-64 duplicate and invalid), bulk-chunk worker (AS-51 duplicate and invalid).
- The k6 script `scripts/load-tests/public-api-mixed.test.js` (30,000 requests per second, 100,000 keys, mixed reads/batch/bulk, per-key limits across instances) proves SC-010. It is an ops artifact, not part of this table.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create key, secret shown once, hash stored, event | `api-keys.e2e-spec.ts` | W04 `developers.spec.ts` (create, reveal once) | — |
| AS-02 create validation classes | `api-keys.e2e-spec.ts` | — | — |
| AS-03 who may manage keys; cross-tenant key IDs | `api-keys.e2e-spec.ts` | — | — |
| AS-04 sensitive routes, step-up for live keys | `api-keys.e2e-spec.ts` | — | — |
| AS-05 active-key limit under concurrent creation | `api-keys.e2e-spec.ts` | — | — |
| AS-06 rotate with overlap | `api-keys.e2e-spec.ts` | W04 `developers.spec.ts` (rotate) | — |
| AS-07 illegal rotations; concurrent rotate | `api-keys.e2e-spec.ts` | — | `key-status.spec.ts` (transition table) |
| AS-08 revoke immediate, idempotent | `api-keys.e2e-spec.ts` | W04 `developers.spec.ts` (revoke) | — |
| AS-09 revoke races a cache fill | `api-keys.e2e-spec.ts` | — | — |
| AS-10 key expiry at the boundary | `api-keys.e2e-spec.ts` | — | — |
| AS-11 `lastUsedAt` write-behind, monotonic | `api-keys.e2e-spec.ts` | — | — |
| AS-12 shop deleted revokes keys once (duplicate, invalid payload) | `developer-platform-consumers.e2e-spec.ts` | — | — |
| AS-13 one refusal for every bad credential | `public-api-auth.e2e-spec.ts` | — | — |
| AS-14 failed-authentication throttle and counters | `public-api-auth.e2e-spec.ts` | — | — |
| AS-15 scopes per endpoint | `public-api-auth.e2e-spec.ts` (`it.each` over routes) | — | — |
| AS-16 cross-tenant access is 404 on every route | `public-api-auth.e2e-spec.ts` | — | — |
| AS-17 shop status gate (suspended, offboarding, events, staleness) | `public-api-auth.e2e-spec.ts` | — | — |
| AS-18 key store degraded (fast store down, both down) | `public-api-auth.e2e-spec.ts` | — | — |
| AS-19 secrets never leak (logs, events, errors, metrics) | `public-api-auth.e2e-spec.ts` | — | — |
| AS-20 key format, hash, parse, constant-time compare | — | — | `api-key-format.spec.ts` |
| AS-21 hashing secret mandatory at startup | `public-api-auth.e2e-spec.ts` (boot fails) | — | — |
| AS-22 sandbox and live isolation both ways | `public-api-sandbox.e2e-spec.ts` | — | — |
| AS-23 first use creates one sandbox shop (10 parallel) | `public-api-sandbox.e2e-spec.ts` | — | — |
| AS-24 sandbox has no orders, no usage, no quota | `public-api-sandbox.e2e-spec.ts` | — | — |
| AS-25 key mode bound to the key | `public-api-sandbox.e2e-spec.ts` | — | — |
| AS-26 first key pins the shop; new version does not move it | `public-api-versions.e2e-spec.ts` | — | — |
| AS-27 version resolution order and echo; invalid version | `public-api-versions.e2e-spec.ts` | — | `versioning.spec.ts` (resolution table) |
| AS-28 responses downgraded by transformers | `public-api-versions.e2e-spec.ts` (one wired product, order, list) | — | `versioning.spec.ts` (every change × resource) |
| AS-29 requests upgraded; `fields` in requested version names | `public-api-versions.e2e-spec.ts` | — | — |
| AS-30 pin the version from the dashboard | `public-api-versions.e2e-spec.ts` | W04 `developers.spec.ts` (pin) | — |
| AS-31 transformer and deprecation registry rules | — | — | `versioning.spec.ts`, `deprecation.spec.ts` (+ `fast-check` round trip) |
| AS-32 deprecated route headers (incl. on errors) | `public-api-versions.e2e-spec.ts` | — | `deprecation.spec.ts` (header value table) |
| AS-33 deprecated version headers | `public-api-versions.e2e-spec.ts` | — | — |
| AS-34 sunset `410`, brownout window | `public-api-versions.e2e-spec.ts` | — | `deprecation.spec.ts` (window evaluation) |
| AS-35 deprecation telemetry per key | `public-api-logs-usage.e2e-spec.ts` | — | — |
| AS-36 registry vs OpenAPI; additive-only | `public-api-contract.e2e-spec.ts` | — | — |
| AS-37 cursor pagination stable; strict limits | `public-api-resources.e2e-spec.ts` | — | — |
| AS-38 `fields` and `expand`, one batch lookup | `public-api-resources.e2e-spec.ts` | — | `sparse-fields.spec.ts` (parse table) |
| AS-39 create product, validation classes | `public-api-resources.e2e-spec.ts` | — | — |
| AS-40 update with `If-Match`; concurrent patch | `public-api-resources.e2e-spec.ts` | — | — |
| AS-41 stock read and deprecated route | `public-api-resources.e2e-spec.ts` | — | — |
| AS-42 orders: the shop's slice, no buyer data | `public-api-resources.e2e-spec.ts` | — | — |
| AS-43 batch happy path | `public-api-batch.e2e-spec.ts` | — | — |
| AS-44 batch input limits, unsupported operation | `public-api-batch.e2e-spec.ts` | — | — |
| AS-45 per-operation scope and tenant | `public-api-batch.e2e-spec.ts` | — | — |
| AS-46 failure isolation, not one transaction | `public-api-batch.e2e-spec.ts` | — | — |
| AS-47 batch and operation idempotency | `public-api-batch.e2e-spec.ts` | — | — |
| AS-48 batch cost in rate-limit units | `public-api-limits.e2e-spec.ts` | — | — |
| AS-49 batch time budget | `public-api-batch.e2e-spec.ts` | — | — |
| AS-50 bulk stock synchronous (≤ 100) | `public-api-batch.e2e-spec.ts` | — | — |
| AS-51 bulk stock job (duplicate chunk, invalid chunk, crash) | `public-api-batch.e2e-spec.ts` | — | `bulk-chunking.spec.ts` (split, counters) |
| AS-52 large file with unknown products, replay-safe | `public-api-batch.e2e-spec.ts` | — | — |
| AS-53 idempotency: replay, in flight, different body, missing, TTL | `public-api-limits.e2e-spec.ts` | — | — |
| AS-54 concurrent identical requests | `public-api-limits.e2e-spec.ts` | — | — |
| AS-55 per-key rate limit and headers | `public-api-limits.e2e-spec.ts` | — | — |
| AS-56 limiter outage fails open | `public-api-limits.e2e-spec.ts` | — | — |
| AS-57 monthly quota; `usage_unavailable` fails open | `public-api-limits.e2e-spec.ts` | — | — |
| AS-58 one request record per authenticated call | `public-api-logs-usage.e2e-spec.ts` | — | — |
| AS-59 request IDs | `public-api-logs-usage.e2e-spec.ts` | — | — |
| AS-60 search the logs; cross-tenant | `public-api-logs-usage.e2e-spec.ts` | — | — |
| AS-61 event bus down: logging never hurts the request | `public-api-logs-usage.e2e-spec.ts` | — | — |
| AS-62 projector: duplicate, invalid payload | `developer-platform-consumers.e2e-spec.ts` | — | — |
| AS-63 usage report | `public-api-logs-usage.e2e-spec.ts` | — | — |
| AS-64 exact `usage.recorded` (duplicate, late, invalid) | `developer-platform-consumers.e2e-spec.ts` | — | `usage-bucket.spec.ts` (+ property) |
| AS-65 problem details for every error class | `public-api-contract.e2e-spec.ts` | — | — |
| AS-66 body limits and media types | `public-api-contract.e2e-spec.ts` | — | — |
| AS-67 OpenAPI and per-version contract schemas | `public-api-contract.e2e-spec.ts` | — | — |
| AS-68 OWASP API Top 10 mapping complete | `public-api-contract.e2e-spec.ts` (doc check: every referenced scenario ID exists) | — | — |
| AS-69 safe transport defaults | `public-api-contract.e2e-spec.ts` | — | — |
| AS-70 domain boundaries and table ownership | — (static gate: `check:table-ownership --strict`, `check:boundaries`) | — | — |
| AS-71 graceful shutdown and readiness | `public-api-contract.e2e-spec.ts` | — | — |
