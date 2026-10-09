# Test Plan: S54 — Platform toolkit (domain `infrastructure`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (152 scenarios, AS-01 to AS-152). A dash means the layer does not test that scenario. Each scenario is proven once, at the lowest layer that can prove it.

- **API e2e** files live beside the code they prove, under `packages/backend/`. S54 has almost no HTTP endpoint of its own (only `/health/live`, `/health/ready`, `/health/startup`), so each file boots a Nest app from the **real toolkit modules** with the production pipe, filter, prefix and interceptors (`configureHttpApp`), plus a small **test controller module** (test code only) whose routes throw each class of error, hold a configurable delay, write a row, count handler calls, or read the context. Real Postgres (production major version, real migrations) from `docker-compose.test.yaml`; no mocking of the toolkit's own code.
- **System-edge fakes only** (VII.2): the clock (`FakeClock`), the event-loop lag source (injectable sampler; AS-80 uses the real monitor), the DNS resolver (injectable), the outbound server (a local stand-in with scripted delays, status sequences, drip bodies, redirects and TLS), the error tracker (spy). Dependency outages are real: the pool or connection of the store under test is closed (a stop-the-connection helper), never a stub of the toolkit's check.
- **Shutdown and crash rows** (AS-56 to AS-66, AS-70, AS-72) run the fixture app **as a child process** with real `SIGTERM` / `SIGINT`, tiny timings (drain 100–300 ms, hard timeout 1 s) and a recording task registry; the spec reads the recorded sequence and the exit code. The exit function is injectable for the in-process hard-timeout row (AS-62).
- **Concurrency rows** use `Promise.all` (AS-19, AS-33, AS-35, AS-118, AS-130); AS-130 runs two Nest apps on one database.
- **VII.3 mandatory cases**: happy paths (AS-01, AS-116), validation-failure classes (AS-05, AS-06, AS-121), `401` (AS-08, AS-128), other-user / cross-tenant (AS-122, AS-21), idempotency replay, in-flight and different body (AS-116 to AS-120), concurrency (AS-118, AS-130, AS-35), rate limit `429` ordering (AS-128, AS-140; the limiter itself is S50). No state-transition endpoint exists. No async consumer exists in S54, so the VII.4 pair does not apply (S53 owns it).
- **VII.9 forced fallbacks**: breaker open (AS-98, AS-100), shed load (AS-74 to AS-83), store outage with fail-closed idempotency (AS-127), degraded readiness (AS-42). The cache-miss path belongs to S52.
- **Unit** specs sit beside the code, are table-driven (`it.each`), and cover only pure logic: problem-document building, request-ID validation, option validators, shedding policy and hysteresis, shutdown config rule, retry options, retry budget, circuit-breaker state machine, backoff, SSRF address classification and URL validation, client-address resolution, configuration rules, redaction, metrics-registry rules. Time is an argument (a clock), never read. No unit tests for controllers, filter wiring, interceptors, repositories or glue.
- **UI journeys**: none. S54 has no UI. A web client's handling of a problem document or a `503` belongs to the web capabilities' journeys.
- **Static gates** (VII.1): `tsc --noEmit` strict and ESLint for `packages/backend`; the named static checks in the Unit column (scripts to be added by the implementing PR under `packages/backend/scripts/`); `pnpm --dir packages/backend check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict`.
- **Load proof** of SC-002, SC-003, SC-004 and SC-008 (k6 at 2× capacity; a rolling-restart loop; a 60 s database outage) is an operations artifact, not an e2e row.

e2e files (all under `packages/backend/`):

| Short name | File |
|---|---|
| ERR | `libs/common/exceptions-filter/problem-details.e2e-spec.ts` |
| CTX | `libs/infrastructure/context/request-context.e2e-spec.ts` |
| TX | `libs/infrastructure/context/transactions.e2e-spec.ts` |
| HEALTH | `libs/infrastructure/health/health-probes.e2e-spec.ts` |
| SHUT | `libs/infrastructure/lifecycle/graceful-shutdown.e2e-spec.ts` |
| SHED | `libs/common/load-shedding/load-shedding.e2e-spec.ts` |
| HTTP | `libs/infrastructure/http-client/resilient-http-client.e2e-spec.ts` |
| SSRF | `libs/infrastructure/net/safe-request.e2e-spec.ts` |
| IDEM | `libs/infrastructure/idempotency/idempotency.e2e-spec.ts` |
| BOOT | `libs/infrastructure/platform/platform-bootstrap.e2e-spec.ts` |
| OBS | `libs/infrastructure/platform/observability.e2e-spec.ts` |
| DB | `libs/infrastructure/database/database-settings.e2e-spec.ts` |

Unit specs (all under `packages/backend/`):

| Short name | File |
|---|---|
| U-DOC | `libs/common/exceptions-filter/problem-document.spec.ts` |
| U-RID | `libs/infrastructure/context/request-id.spec.ts` |
| U-TXO | `libs/infrastructure/context/transaction-options.spec.ts` |
| U-SHEDP | `libs/common/load-shedding/shedding-policy.spec.ts` |
| U-SDC | `libs/infrastructure/lifecycle/shutdown-config.spec.ts` |
| U-RETO | `libs/infrastructure/http-client/retry-options.spec.ts` |
| U-RETB | `libs/infrastructure/http-client/retry-budget.spec.ts` |
| U-CB | `libs/common/resilience/circuit-breaker.spec.ts` |
| U-CORE | `libs/common/core/core-utils.spec.ts` (backoff table) |
| U-SSRF | `libs/infrastructure/net/ssrf-guard.spec.ts` |
| U-URL | `libs/infrastructure/net/safe-url.spec.ts` |
| U-IP | `libs/infrastructure/platform/client-ip.spec.ts` |
| U-CFG | `libs/common/config/config-rules.spec.ts` |
| U-RED | `libs/common/logging/redaction.spec.ts` |
| U-MET | `libs/common/telemetry/metrics-registry.spec.ts` |

Static checks (Unit column, "static:"): `check:no-request-scope`, `context-augmentation.type-test.ts` (compile-time), `check:image-definition`, `check:no-startup-migration`, `check:table-ownership --strict` with `check:boundaries`, `check:no-wallclock`.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 Domain error renders all problem members, `type`, `instance`, header equals `requestId` | ERR | — | — |
| AS-02 Programmer `TypeError` → `500 internal_error`, nothing leaked, stack in log, tracker once | ERR | — | — |
| AS-03 `5xx` wrapping a DB error → catalogue detail, no table name | ERR | — | — |
| AS-04 No debug members in `development`, `test`, unset | ERR | — | — |
| AS-05 Multi-field validation failure, unknown properties rejected, no value echoed | ERR | — | — |
| AS-06 Malformed JSON `400`, oversize `413`, wrong media type `415` | ERR | — | — |
| AS-07 Unmatched route `404`, wrong method `405` with `Allow` | ERR | — | — |
| AS-08 `401` keeps `WWW-Authenticate`, `403` leaks nothing | ERR | — | — |
| AS-09 Raw unique violation → `409 conflict`, no column or value | ERR | — | — |
| AS-10 `Retry-After`, extensions merged, reserved members not overridable | — | — | U-DOC |
| AS-11 `4xx` logged `warn` without stack, `5xx` `error` with stack, `requestId` on all | ERR | — | — |
| AS-12 Duplicate problem `code` with different status fails startup | ERR | — | — |
| AS-13 Error after headers sent: no second write, connection destroyed, no crash | ERR | — | — |
| AS-14 Sensitive path parameter replaced by the template in `instance` and logs | ERR | — | — |
| AS-15 Every collected response parses with the contracts schema | ERR | — | — |
| AS-16 Circular extension → minimal `500` fallback, filter never throws | — | — | U-DOC |
| AS-17 Missing `X-Request-Id` → UUIDv7 in response, logs, context, error body | CTX | — | — |
| AS-18 Inbound request-ID validation table (valid kept; short, long, control chars, duplicate replaced) | — | — | U-RID |
| AS-19 50 concurrent requests each read their own `requestId` after awaits | CTX | — | — |
| AS-20 Guard-set `userId` and `shopId` visible to repository and logs | CTX | — | — |
| AS-21 `shopId` cannot change to another value in one context | CTX | — | — |
| AS-22 Consumer/job runs isolated; context inactive after the run | CTX | — | — |
| AS-23 Reads outside a run return `undefined`, `set` is a no-op | CTX | — | — |
| AS-24 `snapshot()` returns exactly the envelope fields as a copy | CTX | — | — |
| AS-25 `memo` runs the factory once per request, separate per request | CTX | — | — |
| AS-26 No request-scoped provider anywhere | — | — | static: `check:no-request-scope` |
| AS-27 Typed context augmentation compiles; undeclared key fails | — | — | static: `context-augmentation.type-test.ts` |
| AS-28 Two services compose in one transaction without a transaction argument | TX | — | — |
| AS-29 Failure rolls back both writes, error unchanged, no `afterCommit` ran | TX | — | — |
| AS-30 `afterCommit` once, after commit, in order; failing callback isolated | TX | — | — |
| AS-31 Nested `run` joins (same transaction id); inner failure rolls back outer | TX | — | — |
| AS-32 `requires_new` inner commits independently of outer rollback | TX | — | — |
| AS-33 20 concurrent scopes have 20 distinct transactions, no leakage | TX | — | — |
| AS-34 Queries after a scope ends run outside any transaction | TX | — | — |
| AS-35 Serializable write skew: exactly one removal persists | TX | — | — |
| AS-36 Retry on `40001`/`40P01` up to 3, never on `23505`, exhaustion → `503 transaction_conflict` | TX | — | — |
| AS-37 Statement timeout → `503 database_timeout`; lock timeout → `503 db_lock_timeout` | TX | — | — |
| AS-38 Timeout option bounds table (0, −1, NaN, 1.5, injection string, 700 000) | — | — | U-TXO |
| AS-39 `assertActiveTransaction` throws outside, returns the transaction inside | TX | — | — |
| AS-40 Network call inside a transaction refused; works from `afterCommit` | TX | — | — |
| AS-41 `/health/live` `200` with database and cache down, no store access | HEALTH | — | — |
| AS-42 `/health/ready` `200` with shared dependencies down, reported `down` | HEALTH | — | — |
| AS-43 Pod-local critical check failing → `503`, recovers after cache TTL | HEALTH | — | — |
| AS-44 Promoted shared check with `failureThreshold: 3` | HEALTH | — | — |
| AS-45 `/health/startup` and `/health/ready` `503` during warm-up, `/health/live` `200` | HEALTH | — | — |
| AS-46 Startup never regresses during shutdown | HEALTH | — | — |
| AS-47 Shutdown start: `/health/ready` `503` at once, `/health/live` `200`, normal requests served | HEALTH | — | — |
| AS-48 Hanging check reported `down` at its timeout, abort fired, response under 1 s | HEALTH | — | — |
| AS-49 Check results cached, concurrent probes share one evaluation | HEALTH | — | — |
| AS-50 Probe body has names and `up`/`down` only; message in log and gauge | HEALTH | — | — |
| AS-51 Probes exempt from shedding, auth, rate limit, access log, metrics, prefix | HEALTH | — | — |
| AS-52 Liveness fails only above the extreme event-loop threshold | HEALTH | — | — |
| AS-53 Heartbeat silence fails liveness; unregistering at consumer stop avoids false failure | HEALTH | — | — |
| AS-54 Management listener for apps with no HTTP surface | HEALTH | — | — |
| AS-55 `platform_ready` and `health_check_up` gauges | HEALTH | — | — |
| AS-56 Full shutdown order with recorded sequence and exit `0` | SHUT | — | — |
| AS-57 In-flight request completes with `Connection: close`; new connections refused | SHUT | — | — |
| AS-58 Keep-alive socket served during drain delay, idle socket closed after | SHUT | — | — |
| AS-59 Request-drain timeout destroys stuck socket and continues | SHUT | — | — |
| AS-60 In-flight DB query during drain succeeds; pools close after the drain | SHUT | — | — |
| AS-61 Task failure and task timeout logged, later tasks run, exit `1` | SHUT | — | — |
| AS-62 Hard timeout forces exit `1` with `forced shutdown` | SHUT | — | — |
| AS-63 Second SIGTERM and SIGINT ignored; tasks run once | SHUT | — | — |
| AS-64 Equal orders concurrent, lower first; registration after shutdown rejected | SHUT | — | — |
| AS-65 Drain-phase task ends streams during the HTTP drain | SHUT | — | — |
| AS-66 Crash handlers: stderr sync write, exit `1` within 2 s, no drain | SHUT | — | — |
| AS-67 `drain + request drain >= hard timeout` fails startup | — | — | U-SDC |
| AS-68 Server keep-alive 65 s, headers 66 s, request timeout; ≤ 60 s fails startup | BOOT | — | — |
| AS-69 Image uses init in exec form, `STOPSIGNAL SIGTERM`, grace headroom | — | — | static: `check:image-definition` |
| AS-70 Invalid config exits `1` without listening; slow database retried; deadline exits `1` | SHUT | — | — |
| AS-71 No migration or schema sync call in any app bootstrap | — | — | static: `check:no-startup-migration` |
| AS-72 Worker app without HTTP shuts down with the same sequence minus HTTP | SHUT | — | — |
| AS-73 Below threshold everything admitted; gauge reads the window p99 | SHED | — | — |
| AS-74 Shed `503 service_overloaded`, `Retry-After` 1–3, handler never ran, metric | SHED | — | — |
| AS-75 Priority tier thresholds at lag 250, 450, 1 100 | — | — | U-SHEDP |
| AS-76 Probes and metrics endpoint never shed at lag 5 000 | SHED | — | — |
| AS-77 Hysteresis: stop after two samples below `0.8T`, no flapping on 190/210 | — | — | U-SHEDP |
| AS-78 In-flight cap: default shed at cap, critical admitted to 2× | SHED | — | — |
| AS-79 Aborted requests release the in-flight counter | SHED | — | — |
| AS-80 Real monitor sees a 400 ms block and sheds; recovers after idle windows | SHED | — | — |
| AS-81 Shed before body read, auth and rate limit; `Connection: close`; no budget consumed | SHED | — | — |
| AS-82 Shed logs sampled to one `warn` per second; metric counts all | SHED | — | — |
| AS-83 Monitor unavailable fails open; windows do not accumulate | SHED | — | — |
| AS-84 Per-attempt timeout kind `timeout`, socket released | HTTP | — | — |
| AS-85 Retry `503, 503, 200` succeeds on attempt 3 with jittered waits | HTTP | — | — |
| AS-86 No retry for `400/401/403/404/409/422/500` | HTTP | — | — |
| AS-87 `Retry-After` honoured, capped (`3600` fails at once), date form, unparseable fallback | HTTP | — | — |
| AS-88 POST not retried unless declared idempotent; same key every attempt | HTTP | — | — |
| AS-89 Attempt cap 3 sync, 6 background; `maxAttempts: 5` rejected in sync | — | — | U-RETO |
| AS-90 Retry budget 10 % with floor 10 per host per window | — | — | U-RETB |
| AS-91 Context deadline caps the attempt; past deadline fails without network | HTTP | — | — |
| AS-92 Caller abort → `aborted`, no retry, no socket leak | HTTP | — | — |
| AS-93 Response cap → `response_too_large`, bounded memory, no retry | HTTP | — | — |
| AS-94 Invalid JSON or content type → `invalid_response`, no retry | HTTP | — | — |
| AS-95 `302` not followed by default | HTTP | — | — |
| AS-96 20 calls reuse one connection; idle timeout below server's | HTTP | — | — |
| AS-97 Bulkhead: 2 run, 2 wait, 2 `bulkhead_full`; other dependency unaffected | HTTP | — | — |
| AS-98 Breaker CLOSED → OPEN → HALF_OPEN → CLOSED / OPEN with fresh timer | — | — | U-CB |
| AS-99 HALF_OPEN trial slots exhausted → fail at once | — | — | U-CB |
| AS-100 Open breaker with fallback returns `degraded`; fallback error surfaces | — | — | U-CB |
| AS-101 Per-dependency isolation; `4xx` never counts; slow calls count (real client) | HTTP | — | — |
| AS-102 Trace parent sent, `X-Request-Id` only to internal, no secrets in logs/spans/labels | HTTP | — | — |
| AS-103 Full-jitter delay table for attempts 0–6 | — | — | U-CORE |
| AS-104 `safeGet` success shape | SSRF | — | — |
| AS-105 Blocked address and literal-encoding table, 0 connections | — | — | U-SSRF |
| AS-106 Mixed public and private answers → `blocked_address` | — | — | U-SSRF |
| AS-107 Rebinding: connection pinned, one lookup per hop, certificate vs host | SSRF | — | — |
| AS-108 Redirect refused / same-host followed / other host / private / too many | SSRF | — | — |
| AS-109 Scheme, port and userinfo → `invalid_url` before lookup | — | — | U-URL |
| AS-110 Insecure options refused in production | — | — | U-URL |
| AS-111 Overall deadline against slow drip; byte cap sets `truncated` | SSRF | — | — |
| AS-112 Content-type filter → `unsupported_content_type` | SSRF | — | — |
| AS-113 Certificate for another host → `tls_error` | SSRF | — | — |
| AS-114 `unresolvable` and `network_error`, no address or text in message | SSRF | — | — |
| AS-115 `safeRequest` POST: exact body and headers, `snippet`, `3xx` returned | SSRF | — | — |
| AS-116 New key runs handler once; replay returns stored answer with `Idempotency-Replayed: true` | IDEM | — | — |
| AS-117 Replay keeps `Location`/`Content-Type`, drops `Set-Cookie`/`Date` | IDEM | — | — |
| AS-118 10 parallel same-key requests: one runs, nine `409 idempotency_in_flight` | IDEM | — | — |
| AS-119 Different body `422 idempotency_key_reuse`; reordered JSON replays | IDEM | — | — |
| AS-120 Other path or query with same key → `422` | IDEM | — | — |
| AS-121 Key required, invalid forms, ignored on GET and undeclared routes | IDEM | — | — |
| AS-122 Per-principal scope (user, API key, anonymous address) | IDEM | — | — |
| AS-123 TTL boundary at 24 h with the fake clock | IDEM | — | — |
| AS-124 Failures release the key unless `idempotencyFinal` | IDEM | — | — |
| AS-125 Expired lock reclaimed; live lock `409` | IDEM | — | — |
| AS-126 Response over 256 KiB → replay `409 idempotency_replay_unavailable` | IDEM | — | — |
| AS-127 Store unreachable → `503 idempotency_unavailable`, handler not run | IDEM | — | — |
| AS-128 `401` and throttled requests claim no key | IDEM | — | — |
| AS-129 Purge removes only expired records in batches of ≤ 1 000 | IDEM | — | — |
| AS-130 Two instances, 20 requests, one key: exactly one handler run | IDEM | — | — |
| AS-131 `IdempotencyKey` owned by `infrastructure:idempotency`, no domain import | — | — | static: `check:table-ownership --strict` + `check:boundaries` |
| AS-132 Security headers on every response; HSTS only in production | BOOT | — | — |
| AS-133 `public-embed` group relaxes CORS/CORP only for its routes | BOOT | — | — |
| AS-134 CORS allow, deny, exposed headers, preflight list and max-age | BOOT | — | — |
| AS-135 Production empty allowlist or wildcard with credentials fails startup | BOOT | — | — |
| AS-136 Trusted-proxy address resolution table | — | — | U-IP |
| AS-137 Production without trusted-proxy setting fails startup; `none` starts | BOOT | — | — |
| AS-138 Raw bytes available for HMAC; over the limit `413` | BOOT | — | — |
| AS-139 Compression rules (size, event stream, `no-transform`) | BOOT | — | — |
| AS-140 Pipeline order and precedence of shed, CORS, `401`, `429`, `400` | BOOT | — | — |
| AS-141 All invalid keys in one message, no values, secret absent from logs | BOOT | — | — |
| AS-142 Capability rules (paired secret, HTTPS base, origin, distinct and length) | — | — | U-CFG |
| AS-143 `platform_currency` validation; origins exposed | — | — | U-CFG |
| AS-144 Pool arithmetic `20 × 10 > 150` fails; `7` starts | — | — | U-CFG |
| AS-145 Connection settings and acquire-timeout fail-fast `503 database_unavailable` | DB | — | — |
| AS-146 Replica handle read-only; production certificate verification | DB | — | — |
| AS-147 One access-log line per request; `requestId` on all lines; no query or body | OBS | — | — |
| AS-148 Redaction at any depth, case-insensitive, one JSON line | — | — | U-RED |
| AS-149 Forbidden labels, duplicate conflicts, naming rules | — | — | U-MET |
| AS-150 Unmatched paths collapse to one series; metrics endpoint not public; overflow series | OBS | — | — |
| AS-151 All toolkit time reads use the injected clock; no wall-clock in pure logic | — | — | static: `check:no-wallclock` |
| AS-152 Startup log shows key names and `[set]` only | BOOT | — | — |

Row count check: 152 rows, one layer per row.
