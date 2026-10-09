# Research: S54 — Platform toolkit

No `NEEDS CLARIFICATION` was open: `questions.md` defaults are accepted. This file records the design decisions the plan adds on top of them (each: Decision / Rationale / Alternatives).

## R-1 Problem rendering is a pure builder plus a thin filter
- **Decision**: `problem-document.ts` builds the document from `(error, request facts, catalogue)`; the filter only classifies, logs, sets headers and writes. Fallback document is a constant.
- **Rationale**: AS-10/AS-16 (reserved members, render failure) are provable as table-driven units; the filter cannot throw if the builder is total.
- **Alternatives**: keep logic in the filter (needs HTTP to test every case); class-transformer serialisation (can leak fields).

## R-2 Code registry is DI-based and frozen at module init
- **Decision**: `ProblemCatalogModule.forFeature(entries)` provides entries to a global `ProblemCatalog` which validates duplicates in `onModuleInit` (error names both owners via module name).
- **Rationale**: capabilities register without editing toolkit files (SC-010); startup failure satisfies AS-12.
- **Alternatives**: static const map (every capability edits it); decorator scanning (hidden coupling).

## R-3 Transaction scope joins through the existing CLS shim
- **Decision**: keep `sequelize-cls.ts`; `TransactionRunner.run` reads the CLS transaction; join = run `fn` directly; `requires_new` = `sequelize.transaction` with the CLS value saved/restored. Timeouts set via `SELECT set_config('lock_timeout', $1, true)` with validated integers. `@Transactional` is a method decorator delegating to `run` (no scope-request providers). `afterCommit` hooks stored on the transaction object and flushed from Sequelize's `transaction.afterCommit`.
- **Rationale**: smallest change that fixes G-20/G-21; binds parameters (III.5).
- **Alternatives**: nestjs-cls transactional plugin (second mechanism next to the existing shim; model-injection coupling); passing the transaction explicitly (violates FR-020).

## R-4 Network-in-transaction guard is a context check, not a patch of `undici`
- **Decision**: `ResilientHttpClient` and `safeRequest` call `assertNoActiveTransaction()` (reads the context) before dispatch; increments `network_call_in_transaction_total` then throws a programmer error.
- **Rationale**: those two are the only sanctioned outbound paths (G-58 removes axios); a global monkey-patch would hide the cause.
- **Alternatives**: patching `http`/`fetch` (invasive, hits tests and OTel); lint-only (not a runtime guarantee, AS-40).

## R-5 Readiness cache and single-flight use the injected clock
- **Decision**: `ReadinessService` keeps `{at, report, inflight}`; evaluation reuses the report when `clock.nowMs() - at < ttl`; concurrent callers await the same promise. Checks run with `AbortController` + per-check timeout; failure counter per check drives `failureThreshold`.
- **Rationale**: bounds probe load to one evaluation per TTL per pod (AS-49); the clock makes it testable.
- **Alternatives**: background poller (stale after hang, extra timers at shutdown).

## R-6 Shutdown is one orchestrator with a single signal owner
- **Decision**: `installGracefulShutdown` owns signals and runs: `notReady` → delay → `server.close()` + `closeIdleConnections()` (+ `Connection: close` middleware) → await in-flight with deadline then `closeAllConnections()` → `registry.runAll()` → `app.close()` → exit. `enableShutdownHooks` is **not** enabled (FR-047). The registry no longer hooks `beforeApplicationShutdown`. Telemetry flush is a registry task at order 95. `exit` is an injectable function for tests; e2e additionally uses a child process.
- **Rationale**: fixes G-37/G-39/G-42 with one place that defines order (VIII.4).
- **Alternatives**: Nest `OnApplicationShutdown` ordering (cannot place HTTP drain before tasks); `terminus` (does not own the ordering we need).

## R-7 Load shedding is middleware ahead of the body parsers
- **Decision**: `configureHttpApp` mounts, in order: request context/ID → shedding → CORS/helmet → compression → body parsers (raw body capture) → guards via Nest. Parsers are created by the bootstrap (`bodyParser: false` on `NestFactory.create`). Pure `decide(lag, inflight, priority, state)` with hysteresis state kept outside the policy for table tests.
- **Rationale**: AS-81 requires refusal before bodies are read; Nest's default parser mounting makes order implicit (G-49).
- **Alternatives**: guard/interceptor (body already parsed); reverse-proxy shedding (not testable here).

## R-8 Resilience: breaker in `common`, bulkhead and budget in the client
- **Decision**: `CircuitBreaker` is pure (clock + counters, rolling window as time-bucket ring, no timers). Bulkhead (semaphore + bounded wait queue) and `RetryBudget` stay in `infrastructure/http-client`. Retries happen only in the client; the breaker wraps the whole retried call; `4xx` never trip it.
- **Rationale**: S13/S43/S46 reuse the breaker (CONTRACT); keeps `common` free of I/O (X.3/X.5).
- **Alternatives**: `opossum`/`cockatiel` (extra dependency, wall-clock timers hinder `FakeClock`).

## R-9 SSRF: resolve → validate every address → connect to the pinned address with SNI/Host of the original name
- **Decision**: reuse `ssrf-guard.ts` address classification and the undici `connect` lookup override; add overall deadline via `AbortSignal.timeout`, streaming byte cap, content-type filter, manual redirect loop that re-validates each hop. Injectable `resolver` is the single test seam; production refuses `allowHttpHosts`/`allowPrivateHosts`.
- **Rationale**: DNS-rebinding safe (AS-107); typed failures per FR-061.
- **Alternatives**: library `ssrf-req-filter` (does not pin the connect address across redirects as required).

## R-10 Idempotency store is a table with a unique key; claim is `INSERT … ON CONFLICT DO NOTHING`
- **Decision**: unique `(scope, key)`. Claim: insert `in_flight` row with `lock_expires_at`; on conflict select the row; classify (completed → compare fingerprint → replay or 422; in_flight and lock not expired → 409; in_flight and expired → take over with a conditional update `WHERE lock_expires_at < now AND state='in_flight'`, one affected row). Completion: conditional update `WHERE state='in_flight' AND claim_token=:t` storing status/headers/body **awaited before the response is sent**. Release on non-final failure = delete where claim_token matches. Interceptor operates through the lib's own repository (IX.6: only owner touches the table); it opens no domain transaction and the claim runs on its own short connection, never inside the caller's transaction (so a rollback of business work does not roll back the claim; the stored result reflects the committed outcome).
- **Rationale**: III.6 (constraint, not check-then-write), AS-130 (two instances), fail-closed (FR-067).
- **Alternatives**: Redis `SET NX` (eviction-prone, III.9); advisory locks (no durable result); claim inside the business transaction (a rollback would erase the evidence of a possibly-sent external effect).
- **Scope**: `principal:<userId|apiKeyId>` or `ip:<clientIp>` for anonymous routes (marker from S01).
- **Fingerprint**: SHA-256 over `METHOD\nconcrete-path\nsorted-query\ncanonical-json(body)` (recursively sorted keys; arrays keep order; non-JSON bodies hashed as raw bytes from `rawBody`).
- **Pipeline position**: interceptor after guards and rate limiting, before the ValidationPipe (pipes run after interceptors' pre-phase), so a malformed body with a reused key is caught as reuse first (AS-128, AS-140).

## R-11 Idempotency purge is a registered job function, not a poller
- **Decision**: `PurgeIdempotencyKeysService.purgeBatch(limit=1000)` deletes `expires_at < now() - 1h` using `DELETE … WHERE id IN (SELECT id … LIMIT n FOR UPDATE SKIP LOCKED)`; registered with S49's `JobRegistry` under `platform.purge-idempotency-keys`. Until S49 lands, the service is unit-callable and the e2e calls it directly (AS-131); registration code is behind the S49 contract and added in WP-8 only if `JobRegistry` exists in `infrastructure/jobs` at that time (it does as a lib; verify at implementation).
- **Rationale**: IV.3/VIII.6 single-run across replicas is S49's job.

## R-12 Config engine keeps Joi for platform keys, adds rules layer
- **Decision**: `ConfigRules.register({owner, keys, validate})` collects violations from all owners into one `ConfigError` listing key names and messages without values; platform cross-field rules live in the toolkit, capability rules in their owners. Secrets are never printed (startup log lists `[set]`).
- **Rationale**: AS-141 to AS-144 without rewriting the existing Joi schema (G-71).
- **Alternatives**: migrate everything to zod (large churn, no spec requirement).

## R-13 Metrics registry wraps OTel instruments
- **Decision**: `MetricsRegistry` validates name (`snake_case`, unit suffix for histograms/gauges where applicable), forbidden labels (`userId, shopId, requestId, email, ip, url, path`), conflicting duplicates; series cap through existing OTel view cardinality limit (2 000) with overflow series; route label from the matched template, `unmatched` otherwise. `/metrics` served on the management port only.

## R-14 Clock injection
- **Decision**: `CLOCK` token in `common/core` (no Nest import needed: token is a `Symbol`), global provider module `ClockModule` in `infrastructure/platform`; classes take `@Inject(CLOCK)`. ESLint `no-restricted-properties` bans `Date.now`/`new Date()` in the S54 libs except `clock.ts` (AS-151). Harness overrides with `FakeClock`.

## R-15 Trusted proxy resolution
- **Decision**: pure `resolveClientIp(socketAddr, xffHeader, trusted: Cidr[])` → walks the header from the right, skipping trusted hops, returns the first untrusted (or the socket address); config `trusted_proxies` = CIDR list or `none`; production requires explicit value. Express `trust proxy` stays **off** (we do not rely on `req.ip`).

## R-16 Static checks as scripts under `packages/backend/scripts/`
- **Decision**: `check:no-request-scope`, `check:image-definition`, `check:no-startup-migration` follow the style of `check-module-graph.ts` (ts-node, non-zero exit with file:line).
- **Alternatives**: ESLint custom rules (heavier to author); the dependency-cruiser config cannot see decorators.

## R-17 Caller migration policy
- Callers outside S54 libs are changed only where a name or semantic they use is removed or breaks: `RequestService` (axios) users, `IdempotencyInterceptor` importers (`developer-platform/api/v1.controller.ts`, `public-api.module.ts`), `ssrf-guard`/`pinned-get` users (crawler, webhook endpoints/deliverer), Stripe/channel-sender breaker use, `shutdown-registry` deep importers, `SkipThrottle` on health, old problem members in tests, `Idempotent-Replayed` in web code/tests. Each is a task with its own narrow test.
