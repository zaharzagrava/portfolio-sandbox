# Gaps: current code vs S54 spec

Files in scope (paths under `packages/backend/libs/`): `common/exceptions-filter/exceptions-filter.ts`, `common/errors/error.types.ts`, `common/errors/error-utils/error-utils.service.ts`, `common/request-context/types.ts`, `common/load-shedding/*`, `common/config/*`, `common/logging/logging.module.ts`, `common/telemetry/telemetry.ts`, `common/core/{clock,backoff}.ts`, `infrastructure/context/*`, `infrastructure/health/*`, `infrastructure/lifecycle/*`, `infrastructure/platform/*`, `infrastructure/http-client/*`, `infrastructure/net/*`, `infrastructure/idempotency/idempotency.interceptor.ts`, `infrastructure/database/*` (connection settings), `infra/docker/node/Dockerfile`.

The code is a sound first draft of the shape: an async-local request context, a Sequelize CLS shim, a readiness service with critical and non-critical checks, an ordered shutdown registry, an event-loop monitor, an undici client with jittered retries and a retry budget, an SSRF guard that pins the address. The gaps are the contract details that make each of them safe: no `code` and a leaky body in the filter; readiness that empties the fleet when the database is down; a shutdown that closes pools before the HTTP drain and lets a second SIGTERM kill the process; shedding with one tier; a retry loop with four attempts that sleeps whatever `Retry-After` says; and an idempotency interceptor stored in a cache with the wrong header and codes. Tests are almost absent: the only specs in scope are `core-utils.spec.ts`, `ssrf-guard.spec.ts`, `slo-rules.spec.ts` and an Lambda idempotency spec (`apps/lambdas/src/shared/idempotency.e2e-spec.ts`); **there is no e2e for the filter, the probes, the shutdown, shedding, the client, the transaction runner or the interceptor** (VII.2, VII.9 gate).

## Debt register and ownership check

| Source | State | What S54 does |
|---|---|---|
| D-1, D-2, D-3 (infrastructure imports domain/legacy code, generic types, topics) | resolved (Phase 3) | The S54 libs have 0 `@app/domains/*` imports (grep). Nothing to do; keep the check green. |
| **D-14** (X.3, X.7): LLM provider port and adapters in `assistant/infra/llm`, `llm-meter` calls billing | **open, names `infrastructure`** | Belongs to S46 (meter by publishing `llm.call_completed`, then move the port to `libs/infrastructure/llm`) and S04. S54 contributes only the client primitives (`ResilientHttpClient`, `CircuitBreaker`, response cap) the adapter will use; no change here. |
| **D-16** (X.3, X.7): `libs/infrastructure/elasticsearch` is a product-index adapter | **open, names `infrastructure`** | Belongs to S32. Nothing in S54, except that its probe check must register as `shared` (AS-42). |
| D-6 (layering inside domains), D-8 (barrels export internals) | open, apply to domains | S54 only adds public entry points (G-60) so domains stop deep-importing `@app/infrastructure/idempotency/idempotency.interceptor`, `@app/infrastructure/net/ssrf-guard`, `@app/infrastructure/lifecycle/shutdown-registry.service`. |
| **D-7** (domains import other domains' `*Model`) | open for other domains | The S54 libs register and import no business model. No replacement needed: R1/R2/R3 are not used (spec Assumptions: "No cross-domain data is read"). |
| **D-12** (cross-domain raw SQL, 87 findings at batch 5) | open for other domains | The S54 libs issue no domain SQL. The only SQL strings are `SELECT 1` (`health.module.ts:35`) and `SET LOCAL lock_timeout / statement_timeout` (`transaction-runner.service.ts:31,34`), neither touching a table. The new `IdempotencyKey` table is owned by `infrastructure:idempotency` (IX.3 allowlist) and reached only through the interceptor (IX.6): add its row to `packages/backend/db/ownership.ts` (G-52). |
| D-17 (X.5): file cycle rate-limit decorator ↔ interceptor | open, names S50 | S54 has no part; do not copy that pattern when splitting the idempotency decorator from its interceptor (keep the metadata key in its own file). |
| D-15, D-11, D-10 | open, other capabilities | Not S54. |
| `pnpm --dir packages/backend check:table-ownership` (lines for this domain) | **not run**: the command needed approval in this unattended session (same for `check:boundaries`) | By grep, the S54 libs contain no `@InjectModel`, no `forFeature`, no `sequelize.literal`, no cross-domain `.query(` and no association. Expected lines for this domain: none (0 `MODEL`, 0 `SQL`). **First task of the implementer: run the command and the `--strict` variant, paste the lines for `infrastructure` here, and confirm 0.** After G-52 the new table must appear as `infrastructure:idempotency` and nothing else may query it. |
| Callers of `sequelize.transaction` / `TransactionRunner` | audit | 87 occurrences in 52 files (`grep -c 'Transactional\|TransactionRunner\|\.transaction('`), e.g. `tenancy/infra/shop-transaction.ts`, `tenancy/application/shop.service.ts`, `orders/application/checkout.service.ts`, `payments/infra/payout.jobs.ts`. Each call must move to the toolkit scope (`run`, `@Transactional`) or stay explicit and documented; a transaction that writes tables of two domains is a D-12-class violation owned by that domain's capability (IX.4), not S54. |

## Gaps by area

### Problem details (FR-001 to FR-012, AS-01 to AS-16)

- **G-01** `error.types.ts:94` builds `type` as `https://api.yourdomain.com/errors/<ClassName>`; `AppError` has no `code`, `extensions`, `retryAfterSeconds`, `idempotencyFinal` or `headers`. Add them (params at `:60-62`), add the registry `ProblemCatalogModule.forFeature`, a startup duplicate check (AS-12), and make `code` required on every `Fatal_*`, `Transient_*` and `Domain_*` subclass (`:179-260`). The base URL becomes the config key `problem_type_base_url`.
- **G-02** `exceptions-filter.ts:28,75-78` sends `toJSON(isDevelopment)`: `area` always, `data` and `causes` (with stack lines, `error.types.ts:154-163`) whenever `NODE_ENV !== 'production'` (`:24`). Secure by default is inverted: unset `NODE_ENV` leaks. Send only the FR-001 members; keep the full payload for logs and the span only. Rename `supportTraceId` (`:77`) to `traceId`.
- **G-03** `error-utils.service.ts:38-55`: framework exceptions get `title: 'HTTP Exception'` and a `detail` that joins validation messages (which include constraint text and sometimes values). Map per status to the platform codes (`validation_failed` with `errors[{field, code}]`, `malformed_body`, `payload_too_large`, `unsupported_media_type`, `not_found`, `method_not_allowed`, `unauthenticated`, `forbidden`); preserve `WWW-Authenticate`, `Allow`, `Retry-After` from the thrown exception (AS-05 to AS-08).
- **G-04** `error-utils.service.ts:58-62` maps a unique violation to `400` "A record with this data already exists." (existence oracle) → `409 conflict`, generic (AS-09). Also add `57014` → `database_timeout`, `55P03` → `db_lock_timeout`, `40001`/`40P01` exhausted → `transaction_conflict`, pool acquire timeout → `database_unavailable` (all `503` with `Retry-After`; AS-36, AS-37, AS-145).
- **G-05** 5xx details pass through: `new InternalServerError('Database operation failed.')` and custom details reach `publicPayload.detail` (`error-utils.service.ts:71`, `exceptions-filter.ts:28`). Replace by the fixed catalogue text for every status `>= 500` (AS-03).
- **G-06** `exceptions-filter.ts:64-67` logs every error at `error` with stack (including `404`), through the Nest `Logger`, not the structured logger, so the line has no `requestId`. Split `warn` (operational) and `error` (programmer, with cause chain) and log through the request-scoped logger with `requestId` (AS-11).
- **G-07** `exceptions-filter.ts:76` uses `request.originalUrl` (query string included, so tokens in a query reach the body and the log). Strip the query and substitute the route template for routes declared `@SensitivePathParams` (AS-14); add the decorator.
- **G-08** The filter writes without checking `response.headersSent` and cannot survive a serialisation error (`:71-79`) (AS-13, AS-16). Add a guarded path and the minimal fallback document.
- **G-09** `exceptions-filter.ts:70` reads `x-request-id` from the response header; correct when the context middleware ran. For errors thrown before it (rare) fall back to the context accessor, else generate (AS-17).
- **G-10** No `packages/contracts` source exists for the problem document (the package has only `moon.yml` and `package.json`). Create `problem.ts` with `problemDetailsSchema` (zod) and export it; every e2e parses responses with it (AS-15, VII.6).
- **G-11** Programmer-error reporting: Sentry is called only for `status >= 500` and `captureSentryException` skips tests (`error-utils.service.ts:19-20`); add the spy seam the e2e needs (AS-02) and make the tracker call exactly once per request.
- **G-12** `load-shedding.middleware.ts:35-39` writes its own problem body with a placeholder `type`, no `code`, no `requestId`; replace with the `service_overloaded` problem through the shared renderer (AS-74).
- **G-13** No e2e, no unit for any of the above. Create `problem-details.e2e-spec.ts` and `problem-document.spec.ts` (test-plan).

### Request context (FR-013 to FR-019, AS-17 to AS-27)

- **G-14** `common/request-context/types.ts:8-16` lacks `clientIp`, `traceparent`, `deadlineAt`; add them as optional fields and keep the interface open for declaration merging (P0114, AS-27). Add the compile-time test.
- **G-15** `request-context.service.ts:30-32`: `set` overwrites freely; add the `shopId` immutability rule (AS-21). Add `snapshot()` and `memo()` (AS-24, AS-25). `run` (`:38-45`) already isolates; add a test for concurrent runs and for inactivity afterwards (AS-22, AS-23).
- **G-16** `request-context.module.ts:26-29` accepts a single well-formed header, but a duplicated header arrives as an array or a joined string depending on the server; verify and test the rejection (AS-18). Move the pattern and the generator into a pure function (`request-id.ts`) for the unit table.
- **G-17** The trace parent of the inbound request is not stored in the context, so `snapshot()` and consumer runs cannot carry it (AS-22, AS-24, S49 contract).
- **G-18** No static check for request-scoped providers (AS-26, II.4). Add `check:no-request-scope` (AST scan of `@Injectable({ scope: Scope.REQUEST })`, `Scope.REQUEST` in `@Module`, and `@Inject(REQUEST)`).
- **G-19** The per-request memo for batching helpers (S48 DataLoaders, P0215) does not exist.

### Transactions (FR-020 to FR-027, AS-28 to AS-40)

- **G-20** `transaction-runner.service.ts:28-40`: `sequelize.transaction(...)` inside an active CLS transaction opens a **second independent transaction** on another connection. Add `propagation: 'join' | 'requires_new'`, default join (read the CLS transaction and run `fn` in it); a test comparing transaction ids (AS-31, AS-32).
- **G-21** `:31,34` interpolates `Math.trunc(value)` into `SET LOCAL` with no bounds (`NaN` becomes the text `NaN`; `0` is skipped because of the truthiness check). Validate integers 1 to 600 000 in a pure function and set the values with `set_config(..., true)` bound as parameters (AS-38).
- **G-22** `:47-61` retries up to 5 times and wraps `run` even when called inside an active transaction (retrying inside a transaction is meaningless); cap at 3 attempts (IV.6), refuse when a transaction is already active, map exhaustion to `503 transaction_conflict` (AS-36).
- **G-23** No `@Transactional()` decorator (III.2 names it), no `afterCommit`, no `getActiveTransaction()` / `assertActiveTransaction()` (S53 needs it for `outbox.append`), no network-in-transaction guard (AS-28, AS-30, AS-39, AS-40). Add them to `infrastructure/context`, export through a public entry (G-60).
- **G-24** `transaction.module.ts` (10 lines) and `sequelize-cls.ts` are fine; keep `enableSequelizeCls()` idempotent and add a test that two concurrent scopes never share a transaction (AS-33, AS-34).
- **G-25** Connection settings (AS-145): no `statement_timeout`, `idle_in_transaction_session_timeout` or `application_name` in the pool creation; no acquire timeout; no pool arithmetic check (III.12, AS-144); no read-replica handle with verified TLS (AS-146, S16). Inspect `infrastructure/database` and the Sequelize module factory; add the settings and the tests.
- **G-26** Callers audit (see the table above): each direct `sequelize.transaction` call is moved or documented, and any call that does network I/O inside a scope is moved to `afterCommit`.

### Probes (FR-028 to FR-037, AS-41 to AS-55)

- **G-27** `health.module.ts:31-37` registers Postgres as `critical: true`. Register it `scope: 'shared'`, not critical (AS-42). Cache, broker and search checks also `shared`.
- **G-28** `readiness.service.ts:19,50`: the report has `error` text and `ms` per check, returned by `/readyz` (`health.controller.ts:27`) → names and `up`/`down` only; message to a `warn` log and the gauge (AS-50). Add `scope`, `failureThreshold`, abort signal, a 500 ms default (today `:45` 1 000 ms), the sync-throw guard (`:44-52` already catches; test it).
- **G-29** `readiness.service.ts:40-60` runs every check on every probe: N pods × probe rate × checks queries. Add the 2 s cache and single-flight with the injected clock (AS-49).
- **G-30** No startup state: `/startupz` missing; readiness ignores boot (`health.controller.ts:18-28`). Add `StartupService` with warm-ups and make readiness `503` until started (AS-45, AS-46). `bootstrap-http.ts:46-49` excludes only `livez`, `readyz` from the prefix; add `startupz`.
- **G-31** `/livez` returns uptime and never fails (`:20-22`); add the extreme event-loop threshold and heartbeats (AS-52, AS-53). Remove `uptimeSec` (information, and a changing body).
- **G-32** `health.controller.ts:13` imports `SkipThrottle` from `@nestjs/throttler`, which S50 removes; replace with the probe exemption of the shared exempt list.
- **G-33** Exempt-path lists are triplicated: `logging.module.ts:13-19`, `telemetry.ts:29`, `load-shedding.middleware.ts:6`; each lacks `/startupz` and the metrics path differs. One exported constant, used by all three and by the rate limiter and guards (AS-51).
- **G-34** No management listener for apps without HTTP (AS-54). The worker, projector and payment-processor apps need it; audit `apps/*/main.ts`.
- **G-35** No `Cache-Control: no-store`, no `platform_ready` and `health_check_up` gauges (AS-55).
- **G-36** No e2e at all (the F-01 note says "written", none exists). Create `health-probes.e2e-spec.ts`.

### Shutdown and startup (FR-038 to FR-047, AS-56 to AS-72)

- **G-37** `graceful-shutdown.ts:60-70`: `app.close()` runs `beforeApplicationShutdown` (the registry) first, then closes the HTTP server. Tasks, including order 90 pools, therefore run while requests are still in flight, and the server keeps accepting connections during every task. Rewrite as: mark not-ready → drain delay → `server.close()` + `closeIdleConnections()` → wait for in-flight (deadline) → registry tasks → `app.close()` for module destroy hooks → exit (AS-56, AS-60). Move `ShutdownRegistry` execution out of `beforeApplicationShutdown`.
- **G-38** No request-drain deadline and no `Connection: close` on responses during drain (`:65-70`) (AS-57, AS-59). Track sockets, add `closeAllConnections()` at the deadline, set the header on every response once shutdown began.
- **G-39** `process.once('SIGTERM'|'SIGINT')` (`:79-80`): after the first signal fires no listener remains, so a second SIGTERM terminates the process at once. Use `process.on` with a guard and log the ignored signal (AS-63).
- **G-40** `shutdown-registry.service.ts:28-37`: tasks run sequentially, even with equal order; failures are swallowed and the process exits `0`; `register` works after shutdown began; no `phase: 'drain'`. Implement AS-61, AS-64, AS-65; keep `listTaskNames()` for tests (`:41-43`).
- **G-41** `graceful-shutdown.ts:20-37` timings are options with hard-coded defaults, `NODE_ENV` read from `process.env` (`:33`); `hardTimeoutMs` 30 s (spec 25 s); no `requestTimeout`; no validation. Read from validated configuration and add the cross-field rule (AS-67, AS-68).
- **G-42** `telemetry.ts:109-111` registers its own `process.once('SIGTERM')` flush, racing the drain and breaking the single-owner rule (FR-047). Replace by a registry task at order 95.
- **G-43** `graceful-shutdown.ts:88-98` crash handlers are good (synchronous stderr write, exit 1); add: structured log with `requestId` if available, a non-`Error` reason (`error.stack` may be undefined for thrown strings in `uncaughtException`), exit within 2 s, and a child-process test (AS-66).
- **G-44** No startup ordering: no retry with backoff for dependencies, no startup deadline, no `fail fast` test for an invalid configuration (AS-70). The config service validates with Joi (`api-config.service.ts`) but reports per key and not all at once (verify); fix in G-71.
- **G-45** No static check that bootstraps never run migrations (AS-71, III.11), and none for the image (AS-69): `infra/docker/node/Dockerfile:46-63` uses `tini` and an entrypoint script (good), but no `STOPSIGNAL SIGTERM` was found and `entrypoint.sh` must `exec node`; add `check:image-definition` and the grace-period arithmetic against the deploy manifests.
- **G-46** Workers: `installGracefulShutdown` is only called from `configureHttpApp` (`bootstrap-http.ts:57-58`); audit `apps/*/main.ts` for apps without it (AS-72).
- **G-47** No e2e. Create `graceful-shutdown.e2e-spec.ts` with a child-process fixture app.

### Load shedding (FR-048 to FR-054, AS-73 to AS-83)

- **G-48** `load-shedding.middleware.ts:26`: one threshold, no priority, no hysteresis, no in-flight cap, fixed `Retry-After: '1'` (`:32`), exempt list without `/startupz` and keyed on `req.path` that carries the prefix. Implement `shedding-policy` (pure; AS-75, AS-77), the decorator `@LoadSheddingPriority`, the in-flight counter released on `finish` and `close` (AS-78, AS-79), the randomised `Retry-After`, `Connection: close`, the metric and the sampled log (AS-82).
- **G-49** Ordering: `load-shedding.module.ts:13` applies the middleware with `forRoutes('{*path}')`; Nest mounts its body parsers before module middleware, so bodies are read before shedding (AS-81), and the relative order to the CLS middleware and CORS depends on module import order. Take control of the parsers in `configureHttpApp` and mount in the order of AS-140; test it.
- **G-50** `event-loop-monitor.service.ts`: fail-open path and "monitor unavailable" behaviour absent (AS-83); no injectable lag source for tests (AS-80 uses the real one, the rest the fake); the gauge callback reads `lastP99Ms` (fine). Add the seam.
- **G-51** No e2e (`load-shedding.e2e-spec.ts`), no unit for the policy.

### Resilient HTTP and SSRF (FR-055 to FR-062, AS-84 to AS-115)

- **G-76** `resilient-http-client.ts:59` `maxRetries = 3` gives 4 attempts; replace by `maxAttempts` (3 sync, 6 background) validated up front (AS-89). `:36` remove `500` from the retryable set (AS-86).
- **G-53** `:71-72` sleeps `retryAfterMs` with no ceiling; cap by the remaining budget and fail with `retry_after_exceeds_budget` (AS-87). `parseRetryAfter` (`:129-136`) handles seconds and dates; add the table test, including a negative and `0`.
- **G-54** `:46` one `RetryBudget` per client; make it per host (AS-90). `retry-budget.ts:16` reads `Date.now` by default; inject the toolkit clock (FR-064).
- **G-55** `:101,114,121`: the whole body is buffered with no cap; JSON parse failures are wrapped as retryable network errors. Add `maxResponseBytes` streaming, `invalid_response`, and typed `HttpClientError { kind, status, attempts, retryable }` (AS-93, AS-94). Also `:73` logs the full URL (query included): log host and path only (AS-102).
- **G-56** No bulkhead, no breaker, no overall deadline, no context deadline propagation, no `AbortSignal` handling beyond `signal` merging (`:90`), no `X-Request-Id` policy, no metrics beyond the span (AS-91, AS-97 to AS-102). Add `CircuitBreaker` in `common/resilience` and migrate `infrastructure/stripe/stripe.service.ts` (own breaker), `notifications/infra/providers/channel-sender.ts` and `developer-platform/application/webhook-deliverer.service.ts` to it (S13, S43, S46).
- **G-57** Connect timeout 5 s (`:54`); notes say 1 to 3 s → 3 s. Idle keep-alive 30 s with max 60 s (`:51-52`): ensure below the server's (AS-96).
- **G-58** A second client exists: `request/request.service.ts` (axios, no timeout, rejects with `stack` at `:57`). Remove, migrate callers, and add the lint rule that forbids `axios` outside the client lib.
- **G-59** SSRF: `ssrf-guard.ts:80-81` allows `8443` and plain HTTP for hosts in `allowHttpHosts`; `allowHttpHosts` and `allowPrivateHosts` are built from configuration in `seller-insights/application/crawler.service.ts:53` and `developer-platform/application/webhook-endpoints.service.ts:40` and used in `webhook-deliverer.service.ts:67`; `pinned-get.ts` is GET only, follows redirects manually (up to 3), has no overall deadline (only socket `timeout`, which a slow drip beats), no content-type filter, no typed failures and no TLS check wording. Implement `safeGet` and `safeRequest` per FR-061 with the injectable resolver; refuse the escape hatches in production (AS-110); extend the table in `ssrf-guard.spec.ts` to AS-105 and AS-106; migrate the crawler, webhooks, S02 and S08 callers.
- **G-60** Public entry points: add `index.ts` barrels for `context`, `health`, `lifecycle`, `platform`, `http-client`, `net`, `idempotency`, `common/resilience` (X.4) and update importers.
- **G-61** No e2e for the client (`resilient-http-client.e2e-spec.ts`) or SSRF (`safe-request.e2e-spec.ts`); unit specs for breaker, budget, backoff, options.

### Idempotency (FR-063 to FR-069, AS-116 to AS-131)

- **G-52** `idempotency.interceptor.ts` (entire file) is a Redis-backed draft: header named `Idempotent-Replayed` (`:62`); optional key (`:37`); malformed key `400` (`:38`); key reuse `422` with a plain message; in-flight `409` with a plain message; no `Retry-After`; `scope` falls back to `'anon'` for every anonymous caller (`:40`); fingerprint is `method path JSON.stringify(body)` (`:42`: key order sensitive, no query); stores `4xx` outcomes (`:54`); `tap` stores the response with a fire-and-forget `set` (`:48`, not awaited, so a crash can lose it and a fast replay can see `in-flight`); 60 s lock constant (`:8`); no response cap; Redis errors surface as `500`; no clock; no table. Rewrite as `@Idempotent` + module over the `IdempotencyKey` table, per FR-063 to FR-069. Add the migration (expand/contract, `lock_timeout`), the ownership registry entry (`db/ownership.ts`), the purge function and its job registration with S49.
- **G-62** Callers: `developer-platform/api/v1.controller.ts:57` and `public-api.module.ts:10,18` instantiate the interceptor directly; S10, S13, S15, S20, S22, S07 etc. each add `@Idempotent` on their routes in their own capabilities.
- **G-63** The Lambda idempotency spec (`apps/lambdas/src/shared/idempotency.e2e-spec.ts`) tests another mechanism (event idempotency); keep it out of this plan.
- **G-64** No e2e. Create `idempotency.e2e-spec.ts` with the two-instance race (AS-130).

### Bootstrap, configuration, observability (FR-070 to FR-080, AS-132 to AS-152)

- **G-65** `bootstrap-http.ts:20-25` helmet options: add COOP, Referrer-Policy, HSTS in production; `public-embed` group policy (AS-132, AS-133).
- **G-66** `:29-39` CORS reflect-all when unset, `exposedHeaders` lists `Idempotent-Replayed` (wrong name) and lacks several (AS-134); no `allowedHeaders`/`maxAge`; production empty allowlist must fail startup (AS-135).
- **G-67** `:55` validation pipe lacks `whitelist` and `forbidNonWhitelisted` (AS-05). Expect many existing tests to fail until DTOs declare every property.
- **G-68** No trusted-proxy resolution (grep found none): add `request.clientIp`, the resolver (pure, AS-136), config `trusted_proxies`, production requirement (AS-137).
- **G-69** No body-size limit configuration, no `rawBody` capture (AS-138); no compression (AS-139).
- **G-70** Pipeline order is implicit (module import order); define it once in the bootstrap and test it (AS-140).
- **G-71** Config (`api-config.service.ts`): per-key Joi verification, `load_shedding_lag_ms` and `cors_allowed_origins` optional at `:250-258`; no capability-registered rules, no cross-field rules (pool arithmetic, shutdown timings, paired secrets, origin equality, secret length), no all-errors report without values, no `platform_currency`, `usercontent_origin`, `trusted_proxies`, `problem_type_base_url` keys (AS-141 to AS-144, AS-152). Implement `ConfigRules`; keep the Joi schema for platform keys.
- **G-72** Logging (`logging.module.ts`): redaction paths are one-level wildcards (`:50-63`); log level `debug` outside production; no query-string stripping; the access-log `route` template is not set; `QUIET_PATHS` duplicated (G-33). Implement key-name redaction at any depth (pure, AS-148), the single access line (AS-147), `requestId` on every line (G-06).
- **G-73** Metrics: `telemetry.ts:37-57` has views with allowlists and a 2 000 cardinality limit (good); no registry with naming and forbidden-label rules (AS-149), unmatched-route label (AS-150), no check that `/metrics` is absent from the public listener.
- **G-74** Clock: `common/core/clock.ts` has `Clock`, `SystemClock`, `FakeClock` but no injection token or global module; `Date.now()` is used directly in `readiness.service.ts:43`, `retry-budget.ts:16`, `request` code. Add the `CLOCK` token, a global provider and a lint rule (AS-151).
- **G-75** No e2e for any bootstrap behaviour. Create `platform-bootstrap.e2e-spec.ts`, `observability.e2e-spec.ts`, `database-settings.e2e-spec.ts`.

## Order of work (suggested)

1. Static gates and the table-ownership run (record the zero lines above).
2. G-01 to G-13 (problem details) and the contracts schema, since every other e2e asserts on it.
3. Context and transactions (G-14 to G-26), then probes and shutdown (G-27 to G-47), because S49, S51, S52 and S53 consume them.
4. Shedding, client, breaker, SSRF (G-48 to G-51, G-53 to G-61, G-76), then the idempotency facility (G-52, G-62 to G-64) which unblocks S10, S13, S15, S42.
5. Bootstrap and configuration (G-65 to G-75), then update the callers listed in `questions.md` (`[BREAKING]` lines) and their tests.
