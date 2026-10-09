# Contract: toolkit public entry points (X.4)

Exact names other capabilities depend on (mirrors spec.md "Provides"; this file is the implementation checklist for each `index.ts`). Importers use only these paths; deep imports are removed (G-60).

| Entry point | Exports |
|---|---|
| `@app/common/errors` | `AppError` (params `{ code, status, title, detail, extensions?, retryAfterSeconds?, idempotencyFinal?, headers?, area, causes? }`), `Fatal_*`/`Domain_*`/`Transient_*` (require `code`), `ProblemCatalogModule.forFeature`, platform code constants |
| `@app/common/exceptions-filter` | `AllExceptionsFilter`, `SensitivePathParams(...names)` |
| `@app/common/request-context` | `AppClsStore` (open to declaration merging), `REQUEST_ID_HEADER` |
| `@app/common/core/clock` | `Clock`, `SystemClock`, `FakeClock`, `CLOCK` |
| `@app/common/resilience` | `CircuitBreaker({ name, clock, windowMs, minimumCalls, failureRateThreshold, slowCallMs?, openDurationMs, halfOpenCalls })`, `.execute(fn, { fallback? })`, `.state()` |
| `@app/common/load-shedding` | `LoadSheddingPriority('critical'\|'default'\|'background')`, `EventLoopMonitor.p99Ms()` |
| `@app/common/config` | `ConfigRules.register({ owner, keys, validate })`, `requireTogether`, `httpsUrl`, `distinctSecrets`, `minSecretLength`, `PlatformSettings` |
| `@app/common/telemetry` | `MetricsRegistry.counter/histogram/gauge` |
| `@app/infrastructure/context` | `RequestContext` (`run, requestId, userId, shopId, roles, principalType, clientIp, traceparent, deadlineAt, isActive, set, snapshot, memo`), `TransactionRunner.run(fn, { isolationLevel?, lockTimeoutMs?, statementTimeoutMs?, propagation? })`, `runSerializable(fn, { maxAttempts ≤ 3 })`, `Transactional(options?)`, `getActiveTransaction`, `assertActiveTransaction`, `afterCommit` |
| `@app/infrastructure/health` | `ReadinessService.register({ name, scope, critical?, failureThreshold?, timeoutMs?, check(signal) })`, `LivenessService.registerHeartbeat(name, maxSilenceMs)`, `StartupService.addWarmup(name, fn)` |
| `@app/infrastructure/lifecycle` | `ShutdownRegistry.register({ name, order, phase?, run, timeoutMs? })`, `installGracefulShutdown`, `installCrashHandlers` |
| `@app/infrastructure/http-client` | `ResilientHttpClient.create({ name, internal?, maxConcurrent?, breaker?, retry? })`, `.requestJson<T>(url, opts)`, `HttpClientError { kind, status?, attempts, retryable }` |
| `@app/infrastructure/net` | `safeGet`, `safeRequest`, `SafeRequestError { kind }` |
| `@app/infrastructure/idempotency` | `Idempotent({ required?, ttlSeconds? })`, `IdempotencyModule` |
| `@app/infrastructure/platform` | `configureHttpApp(app, options)`, `SecurityPolicy('public-embed')`, `SensitivePathParams`, `ClockModule` |
| `@app/infrastructure/database` | `READ_REPLICA_CONNECTION` |
| `packages/contracts` | `problemDetailsSchema`, `ProblemDetails` |

Shutdown bands: 10 stop intake, 30 end long-lived work, 50 flush, 80 caches/toolkits, 90 pools/clients, 95 telemetry.

Failure-kind vocabulary — client: `timeout, aborted, status, response_too_large, invalid_response, bulkhead_full, circuit_open, retry_after_exceeds_budget, budget_exhausted`; SSRF: `blocked_address, unresolvable, invalid_url, redirect_refused, redirected_host, too_many_redirects, unsupported_content_type, timeout, tls_error, network_error`.
