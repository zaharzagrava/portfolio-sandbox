# Feature Specification: S54 — Platform toolkit

**Feature Branch**: `S54-platform-toolkit` (spec directory only; no branch is created by this run)

**Created**: 2026-10-06

**Status**: Draft

**Domain**: `infrastructure` (libs `libs/infrastructure/{context,health,lifecycle,platform,http-client,net,idempotency}` and the cross-cutting common libs `libs/common/{exceptions-filter,errors,load-shedding,request-context,config,logging,telemetry,core}`; one technical table, `IdempotencyKey`, owned by `infrastructure:idempotency` per constitution IX.3)

**Input**: "Platform toolkit: problem+json errors, request context and transactions, health probes, graceful shutdown, load shedding, resilient HTTP"

## Summary

Every feature of the marketplace needs the same plumbing: knowing which request, user and shop a piece of work belongs to; failing safely and the same way everywhere; staying up (and being restarted only when restarting helps); shutting down without dropping work; shedding load instead of collapsing; and calling third parties without hanging or amplifying an outage. This capability builds that plumbing once and gives every other capability one set of names to depend on.

It gives the rest of the platform:

1. **One error contract.** Every error response is an RFC 9457 `application/problem+json` document with a stable machine-readable `code`, a safe message, the request ID and nothing that helps an attacker (no stack, SQL, upstream text, or account-existence hints).
2. **A request context** that follows the work through every `await`, consumer message and job run, and **a transaction scope** built on it, so services compose inside one atomic unit without passing a transaction around, and no network call can happen inside one.
3. **Three honest probes.** Liveness says "restart me" only when the process itself is broken. Readiness says "send me traffic" and does not empty the fleet because a shared dependency is down. Startup says "give me time to boot".
4. **A shutdown that drops nothing**: readiness first, drain, stop intake, flush, close pools, in that order, with a hard deadline, and crash handlers that never keep a corrupted process alive.
5. **Load shedding by priority**: when the event loop or in-flight count says "overloaded", background traffic is refused first, checkout last, and probes never.
6. **A resilient outbound HTTP client** (timeouts, deadline propagation, jittered retries on one layer only, retry budgets, bulkheads, a generic circuit breaker) and an **SSRF-safe mode** for URLs that users supply.
7. **The idempotency-key facility** (`Idempotency-Key`: replay, in-flight `409`, different-body `422`, 24 h TTL) that every money-moving `POST` in the platform shares.
8. **A hardened HTTP bootstrap**: security headers, a strict CORS allowlist, trusted-proxy client address, body limits with raw-body capture, strict validation, compression, schema-validated configuration that fails startup, structured redacted logs, a metrics registry with cardinality rules, and an injectable clock.

## Scope

In scope:

- The problem-details renderer, the error taxonomy (operational vs programmer), the registry of stable problem codes, and the contract schema other packages parse against.
- The request context (HTTP, consumer, job), the transaction scope, `afterCommit` hooks, serializable retry, per-transaction timeouts, the "no network inside a transaction" guard, and the database connection settings that go with them (timeouts, acquire timeout, pool arithmetic, read-replica handle).
- Liveness, readiness and startup probes; the heartbeat watchdog for workers; the management listener for apps with no HTTP surface.
- The graceful-shutdown sequence, the ordered shutdown registry, server timeouts, crash handlers, startup ordering (fail fast on bad configuration, bounded retry on slow dependencies).
- Event-loop monitoring, priority-aware load shedding and the in-flight cap.
- The resilient HTTP client, the generic circuit breaker, bulkheads, retry budgets, and the SSRF-safe request functions (`safeGet`, `safeRequest`).
- The `Idempotency-Key` facility and its table.
- The HTTP bootstrap: pipeline order, security headers, CORS, trusted proxies, body limits and raw body, compression, validation pipe, the metrics registry, structured logging and redaction, configuration validation and capability-registered rules, the injectable clock, the platform settings other capabilities read.

Out of scope (owned elsewhere, named so nobody re-specifies them):

- **Rate-limit engine, policies and `429` headers**: S50. This capability fixes only the pipeline order relative to it (AS-140).
- **Job scheduling**: S49. This capability registers one purge job through S49's registry (AS-129) and supplies the clock and context S49 consumes.
- **Outbox, inbox, consumers, dead letters, projections**: S53. S53 calls `assertActiveTransaction` and `RequestContext.snapshot()` provided here; consumer idempotency (inbox) is not the HTTP idempotency facility.
- **Cache toolkit** (L1/L2, single-flight, stale-while-revalidate): S52. A cache dependency is "soft" for readiness (AS-42).
- **Realtime push and its connections**: S51. It registers a drain-phase shutdown task here (AS-65).
- **Authentication, sessions, API keys, tenancy membership**: S01, S02, S03, S42. They fill the context fields (AS-20); this capability never decides who a principal is.
- **Admission control that is a product feature** (the waiting room of launch events, flash-sale admission): S22 and S11. Here only generic priority shedding exists (AS-75).
- **Per-domain error codes**: each capability registers its own (AS-12). This capability owns only the platform-wide codes listed under Provides.
- **Infrastructure-as-code** (probe periods, `terminationGracePeriodSeconds`, `preStop`, rolling-update settings, PDBs, ingress rules that hide the probe paths): operations artifacts. This spec states the numbers they must respect (Assumptions) and asserts what can be asserted from the repository (AS-69).
- **Telemetry export pipeline** (collector, dashboards, SLO rules): existing operations artifacts; this capability owns only what the application emits.

## User Scenarios & Testing *(mandatory)*

Actors: **a client** (browser, mobile app, API consumer), **a domain engineer** (writes services and controllers on top of the toolkit), **a background worker** (consumer, job), **an operator** (deploys, watches probes and metrics, reads logs), **an attacker** (probes error messages, forged headers, internal URLs), **a deploy system** (sends SIGTERM and probes).

Time in scenarios: every time comparison in the toolkit reads an injected clock (FR-064), and tests move that clock. "Advance 25 h" means advance the clock, never sleep. Where a scenario needs real elapsed time (a drain, a timeout) the durations are set small through configuration (for example `drain 100 ms`).

### User Story 1 - Every error looks the same and tells nothing it should not (Priority: P1)

A client always gets a problem document with a stable `code` it can switch on and a `requestId` it can quote to support. An attacker learns nothing from messages: no stack, no SQL, no "this email already exists". Programmer bugs and expected failures are told apart, logged at different levels, and mapped to the right status.

**Why this priority**: Every other capability's failure path goes through this. A leak here is a leak everywhere.

**Independent Test**: A test app with routes that throw each class of error; assert body, headers and logs for each.

**Acceptance Scenarios**:

1. **AS-01** — **Given** a route that throws a domain error with code `order_not_found` and status `404`, **When** a client calls it, **Then** the response is `404`, `Content-Type: application/problem+json`, the body has exactly the members `type`, `title`, `status`, `detail`, `instance`, `code`, `requestId` (plus `traceId` when a trace is active), `type` is `<problem base URL>/order_not_found`, `instance` is the request path without its query string, `code` is `order_not_found`, and the `X-Request-Id` response header equals `requestId`.
2. **AS-02** — **Given** a route that throws a plain `TypeError("x is not a function")` (a programmer error), **When** it is called, **Then** the response is `500` with `code: internal_error`, `detail: "An unexpected error occurred."`, no member of the body contains `TypeError`, `x is not a function`, a file path or a stack line; the log has one `error`-level entry with the full stack and the same `requestId`; the error tracker received the exception once.
3. **AS-03** — **Given** a route whose service wraps a database failure `relation "Product" does not exist` in an internal-server error with its own message, **When** it is called, **Then** the response is `500` `internal_error` with the catalogue detail, and neither the table name nor any text of the wrapped cause appears in the body; for every status `>= 500` the `detail` is the fixed catalogue text of the code, never the thrown message.
4. **AS-04** — **Given** the application runs with `NODE_ENV` set to `development`, `test` or unset, **When** any error is returned, **Then** the body still has no `data`, `causes`, `area`, `stack` or debug member: debug detail exists only in logs and traces.
5. **AS-05** — **Given** `POST /widgets` with body `{"name": 42, "extra": "x", "password": "hunter2"}` where `name` must be a string, `sku` is required and `extra` and `password` are not declared, **When** it is sent, **Then** the response is `400` `validation_failed` with an `errors` array that lists `name` (wrong type), `sku` (missing), `extra` (not allowed) and `password` (not allowed), each as `{field, code}`, all failures at once, and the string `hunter2` appears nowhere in the body or the logs.
6. **AS-06** — **Given** a JSON route, **When** the body is `{"a":` (malformed), **Then** `400` `malformed_body`; **When** the body is larger than the limit (FR-058), **Then** `413` `payload_too_large` and the handler never runs; **When** the content type is `text/xml`, **Then** `415` `unsupported_media_type`.
7. **AS-07** — **Given** no route `GET /nope`, **When** it is requested, **Then** `404` `not_found` as problem+json; **Given** `GET /widgets` exists but `DELETE /widgets` does not, **When** `DELETE` is sent, **Then** `405` `method_not_allowed` with an `Allow` header listing `GET`.
8. **AS-08** — **Given** a guard that throws "unauthorized" with a `WWW-Authenticate: Bearer` header and another guard that throws "forbidden", **When** each is hit, **Then** `401` `unauthenticated` keeps the `WWW-Authenticate` header and `403` `forbidden` carries neither header nor any role names in the detail.
9. **AS-09** — **Given** a unique constraint on `widget.sku` and an existing widget with `sku: "A-1"`, **When** a second create with `sku: "A-1"` reaches the filter as a raw database unique-violation (the service did not map it), **Then** the response is `409` `conflict` with the catalogue detail, and neither the column, the constraint name nor the value `A-1` appears (no existence oracle).
10. **AS-10** — **Given** a domain error with `retryAfterSeconds: 3`, status `503`, and extension members `{ "limit": 5, "requestId": "forged", "status": 200 }`, **When** it is rendered, **Then** the response has header `Retry-After: 3`, includes the extension member `limit: 5`, and the reserved members `requestId` and `status` keep their real values (extensions cannot override `type`, `title`, `status`, `detail`, `instance`, `code`, `requestId`).
11. **AS-11** — **Given** a `404` domain error and a `500` programmer error, **When** both are returned, **Then** the `404` is logged at `warn` with `code` and no stack, the `500` at `error` with stack and cause chain, and every one of those lines carries `requestId`.
12. **AS-12** — **Given** two capabilities register the same `code` `order_conflict` with different statuses, **When** the application boots, **Then** startup fails and the failure names the code and both owners; the same `code` registered twice with identical definitions boots normally.
13. **AS-13** — **Given** a streaming route that has already sent its headers and then throws, **When** the filter runs, **Then** it writes no second body, destroys the connection, logs the error with `requestId` and does not crash the process.
14. **AS-14** — **Given** a route `GET /share/:token` declared as having a sensitive path parameter, **When** it fails with `404`, **Then** `instance` is `/share/:token` (the template) and the log field `route` is `/share/:token`, so the token never appears in either; a non-sensitive route `GET /widgets/:id` shows `instance` `/widgets/42`.
15. **AS-15** — **Given** the responses of AS-01 to AS-14 collected from a running app, **When** each is parsed with the shared problem-details schema of the contracts package, **Then** every one parses and no unknown reserved member exists.
16. **AS-16** — **Given** an error whose extension members contain a circular object, **When** the filter serialises it, **Then** it falls back to a minimal `500` `internal_error` problem document with `requestId`, logs the serialisation failure, and the request completes (the filter never throws).

### User Story 2 - Work knows which request, user and shop it belongs to (Priority: P1)

A domain engineer reads the request ID, user, shop and trace anywhere in the call graph, in an HTTP request, a consumer message or a job run, without passing parameters, and concurrent work never sees another's values.

**Why this priority**: Logs, events, transactions, tenant safety and tracing all hang from it.

**Independent Test**: A test app and a context harness; fire concurrent work and read values after awaits.

**Acceptance Scenarios**:

1. **AS-17** — **Given** a request without `X-Request-Id`, **When** it is served, **Then** a UUIDv7 `requestId` is created and the same value appears in the response header, in every log line of the request, in the context read inside a service, and in the error body if the request fails.
2. **AS-18** — **Given** inbound `X-Request-Id` values, **When** they are `abc-12345678` (valid: 8 to 128 characters of letters, digits, `.`, `_`, `-`), `abc` (too short), 200 characters, `a b\nc` (space and newline), and two header lines, **Then** the valid one is kept unchanged and each other value is replaced by a fresh UUIDv7; no replaced value is ever logged raw.
3. **AS-19** — **Given** 50 concurrent requests with distinct request IDs whose handlers await a random 0 to 50 ms and then read the context in a nested service, **When** all finish, **Then** each handler saw its own `requestId` and none saw another's.
4. **AS-20** — **Given** an authentication guard that sets `userId`, `principalType: "user"` and a membership guard that sets `shopId`, **When** a repository and the logger read the context later in the same request, **Then** both see those values and every log line after that point carries `userId` and `shopId` (never metric labels, AS-149).
5. **AS-21** — **Given** the context holds `shopId: "shop-A"`, **When** any code tries to set `shopId` to `shop-B` in the same context, **Then** it fails as a programmer error (`500` `internal_error` on HTTP, logged at `error` with both values' hashes, not the values), and `shopId` still reads `shop-A`; setting `shop-A` again is accepted.
6. **AS-22** — **Given** a consumer that runs each message inside a fresh context created with `{ requestId, shopId, principalType: "service", traceparent }`, **When** two messages are processed concurrently, **Then** each sees only its own values and trace; **When** a run ends, **Then** reading the context afterwards (outside any run) returns `undefined` and `isActive()` is false.
7. **AS-23** — **Given** code running outside any context (a bootstrap script), **When** it reads any context field, **Then** it gets `undefined` and nothing throws; `set` is a no-op.
8. **AS-24** — **Given** an active context with request ID, trace parent, user, shop and principal type, **When** `snapshot()` is called, **Then** it returns exactly `{ requestId, traceparent?, userId?, shopId?, principalType }` as plain data that can be written into an event envelope, and mutating the returned object does not change the context.
9. **AS-25** — **Given** a request whose handler calls `memo(key, factory)` 20 times with the same key, **When** it completes, **Then** `factory` ran once and all 20 calls got the same value; **Given** two concurrent requests, **Then** each gets its own value (this is how per-request batching helpers are built without request-scoped providers).
10. **AS-26** — **Given** every provider in `libs/` and `apps/`, **When** the static check runs, **Then** none is declared with request scope; a deliberately added one makes the check fail (constitution II.4).
11. **AS-27** — **Given** a capability that adds an optional field to the typed context through declaration merging, **When** the code is compiled, **Then** reading and writing that field is type-checked, and writing an undeclared key fails compilation (a compile-time test).

### User Story 3 - Services compose inside one transaction and no network call hides in it (Priority: P1)

A domain engineer wraps an application-layer method in one transaction scope; every model call inside joins it without passing a transaction object; failure undoes everything; side effects run only after commit.

**Why this priority**: Atomicity of money and stock depends on it; III.2 and III.3 are only as good as this.

**Independent Test**: Real database; two tiny services writing two tables; inspect rows after commit, rollback and concurrency.

**Acceptance Scenarios**:

1. **AS-28** — **Given** two services that each insert a row through their own models and never receive a transaction object, **When** an application method decorated as transactional (or an explicit `run`) calls both, **Then** both rows are visible after it returns, and during it a second connection sees neither.
2. **AS-29** — **Given** the second service throws after the first inserted, **When** the scope ends, **Then** neither row exists, the error reaches the caller unchanged, and no `afterCommit` callback ran.
3. **AS-30** — **Given** three `afterCommit` callbacks registered inside a scope, **When** it commits, **Then** they run once each, after the commit is visible to other connections, in registration order; **Given** the second callback throws, **Then** the error is logged with `requestId`, the third still runs, and the scope's result and the committed rows are unchanged.
4. **AS-31** — **Given** an inner `run` called inside an outer `run`, **When** both query the transaction identifier, **Then** they are equal (the inner joined); **When** the inner throws and the outer does not catch it, **Then** the outer rolls back and rethrows.
5. **AS-32** — **Given** an inner `run` with `requiresNew`, **When** the inner commits and the outer later rolls back, **Then** the inner's rows remain and the outer's are gone; the inner used a different transaction identifier.
6. **AS-33** — **Given** 20 concurrent scopes (`Promise.all`), each inserting one row with its transaction identifier, **When** they finish, **Then** all identifiers are distinct and each row has exactly its own scope's identifier (no leakage between async contexts).
7. **AS-34** — **Given** a scope that has finished, **When** code in the same request queries again, **Then** the query runs outside any transaction (the identifier differs from the finished one, and its writes are committed on their own).
8. **AS-35** — **Given** two concurrent serializable scopes that each count the shop's owners and, if more than one, remove one (write skew: both would remove, leaving none), **When** run with `Promise.all`, **Then** exactly one removal persists, the shop keeps at least one owner, and the loser was retried and then saw the updated state.
9. **AS-36** — **Given** serialization failure (`40001`) and deadlock (`40P01`) errors, **When** a serializable scope hits them, **Then** it retries with jittered delay up to 3 attempts in total; a unique violation (`23505`) is never retried (1 attempt); **When** all 3 attempts fail with `40001`, **Then** the caller gets `503` `transaction_conflict` with `Retry-After: 1`.
10. **AS-37** — **Given** `statementTimeoutMs: 100` and a statement that sleeps 1 s, **When** run, **Then** the statement is cancelled, the scope rolls back and the caller gets `503` `database_timeout` with `Retry-After: 1`; **Given** `lockTimeoutMs: 100` and a row locked by another connection, **Then** `503` `db_lock_timeout` and a rollback.
11. **AS-38** — **Given** option values `0`, `-1`, `NaN`, `1.5`, `"1; DROP TABLE x"`, `700000` (above 600 000 ms), **When** passed as `statementTimeoutMs` or `lockTimeoutMs`, **Then** each is rejected as a programmer error before any SQL is sent (no value is ever interpolated into SQL text); valid integers `1` to `600000` are accepted.
12. **AS-39** — **Given** code outside any scope, **When** `assertActiveTransaction()` is called, **Then** it throws a programmer error (`internal_error`), and `getActiveTransaction()` returns `undefined`; **Given** inside a scope, **Then** the first returns the active transaction and the second the same object.
13. **AS-40** — **Given** a scope that calls the resilient HTTP client or `safeRequest`, **When** the call is made inside the open transaction, **Then** it rejects at once with a programmer error (`500` `internal_error`; metric `network_call_in_transaction_total` incremented), no request reaches the test server, and the same call made from an `afterCommit` callback succeeds (constitution III.3).

### User Story 4 - Probes that restart only when restarting helps (Priority: P1)

An operator (the deploy system) gets three separate probe endpoints whose meaning matches Kubernetes: startup = booted, liveness = process healthy, readiness = send traffic. A shared database outage does not empty the fleet.

**Why this priority**: Wrong probes turn a database blip into a full outage that outlasts the blip (notes 08/01 §2).

**Independent Test**: A test app with controllable dependency checks; stop real database and cache connections; call the probes.

**Acceptance Scenarios**:

1. **AS-41** — **Given** the database and the cache are both unreachable, **When** `/health/live` is called 100 times, **Then** every answer is `200` `{"status":"ok"}` and no query or connection attempt to either store occurred (pool counters unchanged).
2. **AS-42** — **Given** the database and the cache are unreachable, **When** `/health/ready` is called, **Then** it answers `200` with `{"status":"ok","checks":{"postgres":"down","cache":"down"}}` (reported, not critical: a shared outage must not remove every pod); the same call with both healthy shows `"up"`.
3. **AS-43** — **Given** a pod-local check `local-model` registered as critical and failing, **When** `/health/ready` is called, **Then** `503` `{"status":"unavailable","reason":"dependency","checks":{"local-model":"down"}}`; **When** it recovers and the cache TTL elapses (clock advanced), **Then** the next call is `200`.
4. **AS-44** — **Given** a shared dependency registered as critical with `failureThreshold: 3`, **When** it fails twice then succeeds, **Then** readiness stays `200` throughout and the counter resets; **When** it fails three times in a row, **Then** the third evaluation returns `503`.
5. **AS-45** — **Given** an app whose startup work (a registered warm-up that takes 500 ms) is running, **When** `/health/startup` and `/health/ready` are called, **Then** both answer `503` `{"status":"unavailable","reason":"starting"}` while `/health/live` answers `200`; **When** the warm-up completes, **Then** `/health/startup` answers `200` and `/health/ready` answers `200`.
6. **AS-46** — **Given** startup completed, **When** shutdown begins, **Then** `/health/startup` still answers `200` (startup never regresses) while `/health/ready` answers `503`.
7. **AS-47** — **Given** shutdown has just begun (drain delay 300 ms), **When** `/health/ready`, `/health/live` and an ordinary `GET /widgets` are called during the delay, **Then** `/health/ready` is `503` `{"reason":"shutting_down"}` at once, `/health/live` stays `200` (the process must not be killed mid-drain), and the ordinary request is served normally.
8. **AS-48** — **Given** a readiness check whose promise never settles, **When** `/health/ready` is called, **Then** that check is reported `down` after its timeout (default 500 ms), the response arrives in under 1 s, and the check's abort signal was fired.
9. **AS-49** — **Given** a readiness check with a call counter and a cache TTL of 2 s, **When** 100 concurrent `/health/ready` calls arrive, **Then** the check ran once (concurrent calls share one in-flight evaluation); **When** more calls arrive before 2 s on the injected clock, **Then** still once; **When** the clock advances 2 s, **Then** the next call runs it again.
10. **AS-50** — **Given** a check that fails with the message `password authentication failed for user "app" at 10.0.0.5:5432`, **When** `/health/ready` is called, **Then** the body contains only the check name and `"down"`, the message appears in a `warn` log with `requestId`, and the gauge `health_check_up{check="..."}` is `0`.
11. **AS-51** — **Given** the app is under load shedding (AS-74) and an authentication guard and rate limiter are installed, **When** `/health/live`, `/health/ready`, `/health/startup` are called 1 000 times (also with `HEAD`), **Then** none is shed, none is `401` or `429`, each has `Cache-Control: no-store`, none is logged at `info`, none appears in the HTTP request-duration metric, and none sits under the `/api` prefix.
12. **AS-52** — **Given** the event-loop lag source reports a p99 of 12 000 ms (above the liveness threshold, default 10 000 ms), **When** `/health/live` is called, **Then** `503` `{"status":"unavailable","reason":"event_loop"}`; **Given** it reports 800 ms (a shedding concern, AS-74), **Then** `/health/live` is still `200`.
13. **AS-53** — **Given** a worker registers a heartbeat `consumer:orders` with a maximum silence of 30 s and beats at t = 0, **When** the clock reaches t = 31 s without a beat, **Then** `/health/live` is `503` naming `heartbeat:consumer:orders`; **When** it beats again, **Then** `200`; **Given** shutdown begins and the consumer-stop task unregisters the heartbeat, **Then** liveness does not fail during the rest of the drain.
14. **AS-54** — **Given** an app with no HTTP surface (a worker or projector) configured with a management port, **When** it boots, **Then** `/health/live`, `/health/ready`, `/health/startup` answer on that port only, and an app that has its own HTTP listener serves them on its main listener.
15. **AS-55** — **Given** an app that is ready, **When** shutdown begins, **Then** the gauge `platform_ready` is `1` before and `0` after, and `health_check_up` has one series per registered check.

### User Story 5 - A deploy drops no request (Priority: P1)

The deploy system sends SIGTERM; in-flight work finishes, new traffic stops arriving first, consumers stop before pools close, and anything stuck is cut off by a deadline. A crash is a crash: log, exit, let the supervisor restart.

**Why this priority**: Every rolling deploy exercises it; a flaw drops customer requests and orders.

**Independent Test**: A fixture app run as a child process with a test shutdown registry and real signals; assert the recorded sequence and exit code.

**Acceptance Scenarios**:

1. **AS-56** — **Given** tasks registered at orders 10, 30, 50, 80, 90 and 95 that append their name and time to a log, drain delay 200 ms and an in-flight request of 300 ms, **When** SIGTERM is sent, **Then** the log shows in this order: readiness false, drain delay elapsed, server stopped accepting, in-flight finished, task 10, task 30, task 50, task 80, task 90, task 95, exit code `0`; no task starts before the in-flight request finishes.
2. **AS-57** — **Given** a request that takes 2 s and was accepted before SIGTERM, **When** SIGTERM arrives 100 ms later, **Then** it completes with `200` and the response carries `Connection: close`; a new connection attempted after the server stopped accepting is refused; the process exits `0` after the request completes and before the hard timeout.
3. **AS-58** — **Given** an idle keep-alive connection and another that sends a request during the drain delay, **When** SIGTERM arrives, **Then** the request on the kept-alive connection is served `200` with `Connection: close`, and the idle connection is closed once the delay ends.
4. **AS-59** — **Given** a handler that never finishes and a request-drain timeout of 500 ms, **When** SIGTERM arrives, **Then** after 500 ms its socket is destroyed, a `warn` log `shutdown_request_drain_timeout` records the count, and the sequence continues to the registered tasks.
5. **AS-60** — **Given** an in-flight request that issues a database query 200 ms after SIGTERM, **When** the sequence runs, **Then** the query succeeds (the database pool closes only after HTTP drain), and the pool-closing task ran after the request completed.
6. **AS-61** — **Given** a task at order 30 that throws and a task at order 50 that exceeds its `timeoutMs`, **When** shutdown runs, **Then** both failures are logged with the task name, tasks at 80, 90 and 95 still run, and the exit code is `1`.
7. **AS-62** — **Given** the hard timeout is 1 s and a pool-closing task that hangs with a task timeout of 10 s, **When** shutdown runs, **Then** at 1 s the process logs `forced shutdown` and exits with code `1` (the exit function is injected in the test).
8. **AS-63** — **Given** shutdown has begun, **When** a second SIGTERM and a SIGINT arrive, **Then** both are ignored with an `info` log, every task ran exactly once and one exit happened.
9. **AS-64** — **Given** two tasks at the same order and one at a lower order, **When** shutdown runs, **Then** the lower runs first and completes, then the two same-order tasks run concurrently; **Given** a task registered after shutdown began, **Then** registration is rejected with an error and a log line.
10. **AS-65** — **Given** a long-lived stream request and a task registered with phase `drain` that ends all streams spread over 300 ms, **When** SIGTERM arrives, **Then** the task runs during the HTTP drain (not after it), the stream ends cleanly before the request-drain timeout, and no `shutdown_request_drain_timeout` is logged.
11. **AS-66** — **Given** a fixture process, **When** an `unhandledRejection` is raised with an `Error`, with a string, and with `undefined`, and when an `uncaughtException` is raised, **Then** in every case the cause (stack when there is one) is written to stderr synchronously and to the structured log, the process exits with code `1` within 2 s, runs no drain and serves no further request.
12. **AS-67** — **Given** configuration where `drainDelayMs + requestDrainTimeoutMs >= hardTimeoutMs`, **When** the app starts, **Then** startup fails and names the three keys and values.
13. **AS-68** — **Given** a production configuration, **When** the HTTP server starts, **Then** the keep-alive timeout is 65 000 ms (above the load balancer's 60 000 ms idle timeout), the headers timeout is 66 000 ms (above keep-alive), a request timeout is set (default 30 000 ms), and a configured keep-alive timeout of 60 000 ms or less fails startup.
14. **AS-69** — **Given** the application image definition and process supervision settings in the repository, **When** the static check runs, **Then** the final stage starts the app directly (exec form, no shell or package-manager script) under an init process that forwards signals and reaps children, declares `SIGTERM` as the stop signal, and the configured grace period leaves at least `drain + request drain + 5 s` of headroom.
15. **AS-70** — **Given** an invalid configuration (three bad keys, one of them a secret), **When** the app starts, **Then** it exits `1` within 5 s without listening on any port, the message lists all three key names and the reason of each but no value; **Given** the database refuses connections for the first 3 s, **Then** startup retries with jittered backoff, `/health/startup` stays `503`, and the app becomes started once the database answers; **Given** it never answers within the startup deadline (default 30 s; 2 s in the test), **Then** the process exits `1`.
16. **AS-71** — **Given** the bootstrap code of every app, **When** the static check scans it, **Then** it finds no call that runs migrations or synchronises the schema at startup (constitution III.11); a deliberately added call fails the check.
17. **AS-72** — **Given** a worker app with no HTTP server, a consumer and a pool, **When** SIGTERM arrives, **Then** it marks not-ready on the management listener, stops the consumer (order 10), flushes (50), closes pools (90), and exits `0`, without any HTTP step.

### User Story 6 - Overload is refused cheaply, background first, checkout last (Priority: P2)

A client may receive `503` with `Retry-After` when the instance is saturated, but critical traffic survives longer than background traffic, the instance recovers by itself, and health probes are never refused.

**Why this priority**: Without it a spike turns into a pile-up where every request times out; with it admitted latency stays bounded.

**Independent Test**: A test app with routes of each priority and an injectable lag source; plus one test that blocks the real event loop.

**Acceptance Scenarios**:

1. **AS-73** — **Given** event-loop p99 lag of 50 ms (threshold 200 ms) and in-flight below the cap, **When** requests of every priority arrive, **Then** all are admitted and the gauge `nodejs_eventloop_lag_p99_ms` reads 50.
2. **AS-74** — **Given** lag 450 ms and a route of default priority with a handler spy, **When** it is called, **Then** `503` `service_overloaded` problem+json, `Retry-After` an integer from 1 to 3, `X-Request-Id` present, the handler spy has 0 calls, no row was written, and `http_requests_shed_total{priority="default"}` is 1.
3. **AS-75** — **Given** threshold `T = 200 ms` and routes of priority background, default and critical, **When** lag is 250, **Then** background is shed and default and critical are admitted; **When** lag is 450, **Then** background and default are shed and critical admitted; **When** lag is 1 100, **Then** all three are shed (background at `T`, default at `2T`, critical at `5T`).
4. **AS-76** — **Given** lag 5 000 ms, **When** `/health/live`, `/health/ready`, `/health/startup` and the metrics endpoint are called, **Then** all are served (never shed).
5. **AS-77** — **Given** shedding is active at lag 250, **When** lag samples fall to 190 (above `0.8T`), **Then** background is still shed; **When** two consecutive samples are 150, **Then** background is admitted; **Given** samples alternate 190, 210, 190, 210, **Then** shedding stays on continuously (no flapping).
6. **AS-78** — **Given** an in-flight cap of 5 and 5 slow requests running, **When** a sixth default-priority request arrives, **Then** `503` `service_overloaded`; a sixth critical request is admitted (critical is admitted up to twice the cap); **When** in-flight falls below the cap, **Then** default is admitted again.
7. **AS-79** — **Given** 20 requests that the client aborts mid-flight, **When** they end, **Then** the in-flight counter returns to its starting value (no leak) and later requests are admitted.
8. **AS-80** — **Given** the real monitor, a threshold lowered to 50 ms for the test, and a route that blocks the event loop synchronously for 400 ms, **When** it is called and the next 1 s sampling window completes, **Then** the gauge shows a p99 of at least 300 ms and a following default-priority request (shed at `2T` = 100 ms) is answered `503`; **When** the loop stays idle for two further windows, **Then** requests are admitted again.
9. **AS-81** — **Given** shedding is active, **When** a `POST` with a 1 MiB body, an invalid token and a rate-limit spy arrive, **Then** the response is `503` sent with `Connection: close` before the body is read, the authentication guard and the rate-limit spy are not called, and no rate-limit budget was consumed.
10. **AS-82** — **Given** 1 000 shed requests within one second, **When** logs are inspected, **Then** at most one `warn` line per second exists, carrying `shedCount`; the counter metric counts all 1 000.
11. **AS-83** — **Given** the monitor is disabled or fails to start, **When** requests arrive, **Then** they are admitted (fail open), one `error` log is written once, and no gauge series is exported; **Given** the monitor runs, **Then** each 1 s window's p99 replaces the previous (no accumulation across windows).

### User Story 7 - Calling a third party cannot hang or amplify an outage (Priority: P2)

A domain engineer calls an external API through one client: it always times out, retries only what is safe, stops retrying when the dependency is in trouble, bounds concurrency per dependency, and fails fast when a dependency is known to be down.

**Why this priority**: Every integration (Shopify, LLM, couriers, payments) depends on it; one hung call pile-up takes the service down (notes 06/03 §8).

**Independent Test**: A controllable local server (delays, status sequences, drip bodies, redirects) and a fake clock.

**Acceptance Scenarios**:

1. **AS-84** — **Given** a server that answers after 2 s and a call with `timeoutMs: 200` and one attempt, **When** it is made, **Then** it rejects with kind `timeout` in at most 300 ms and the socket is released.
2. **AS-85** — **Given** a server that answers `503, 503, 200`, **When** an idempotent `GET` is made with defaults, **Then** it succeeds on the 3rd attempt, the server saw exactly 3 requests, and each wait before attempt `n` lay in `[0, min(cap, base × 2^n)]`.
3. **AS-86** — **Given** a server that answers each of `400`, `401`, `403`, `404`, `409`, `422`, `500`, **When** an idempotent `GET` is made, **Then** the server saw exactly 1 request and the client raised kind `status` with that status; (only timeouts, connection resets or refusals, `408`, `425`, `429`, `502`, `503`, `504` are retried).
4. **AS-87** — **Given** `429` with `Retry-After: 1`, **When** retried, **Then** the wait is at least 1 s; **Given** `Retry-After: 3600`, **Then** the client fails at once with kind `retry_after_exceeds_budget` and does not sleep; **Given** an HTTP-date `Retry-After` 2 s in the future, **Then** it waits about 2 s; an unparseable value falls back to jittered backoff.
5. **AS-88** — **Given** a `POST` with no declaration, **When** the server answers `503`, **Then** exactly 1 attempt; **Given** the same call declared `idempotent: true` and carrying an `Idempotency-Key`, **Then** it retries and every attempt sends the same key.
6. **AS-89** — **Given** defaults, **When** a call asks for `maxAttempts: 5`, **Then** it is rejected before any network call (synchronous profile allows at most 3); **Given** `profile: "background"` and `maxAttempts: 5`, **Then** it is accepted; `maxAttempts: 1` never retries.
7. **AS-90** — **Given** 100 calls to host A in a 10 s window with a failing server, **When** retries are attempted, **Then** at most 10 % of requests (minimum 10) are retried, further failures surface the original error without a retry, and `http_client_retry_budget_exhausted_total{dependency}` increments; **Given** host B in the same client, **Then** its budget is untouched and its retries proceed (budget is per host).
8. **AS-91** — **Given** a request context whose deadline has 300 ms left and a call with `timeoutMs: 5000`, **When** the server is slow, **Then** the attempt aborts at about 300 ms with kind `timeout`, no retry starts past the deadline, and when the deadline is already past the call rejects at once without touching the network.
9. **AS-92** — **Given** a caller `AbortSignal` aborted 50 ms into a 1 s server delay, **When** the call is made, **Then** it rejects with kind `aborted`, is not retried, and the connection pool shows no leaked socket.
10. **AS-93** — **Given** a server streaming 5 MiB and `maxResponseBytes: 1 MiB` (the default), **When** read, **Then** the client stops at the cap, rejects with kind `response_too_large`, holds at most the cap plus one chunk in memory, and does not retry.
11. **AS-94** — **Given** a `200` with an invalid JSON body or a content type that is not JSON, **When** parsed as JSON, **Then** kind `invalid_response`, no retry, and no part of the body in the error message beyond the first 200 characters sanitised.
12. **AS-95** — **Given** a server answering `302` with `Location`, **When** called with defaults, **Then** the redirect is not followed, the client raises kind `status` with status `302` and the server saw one request.
13. **AS-96** — **Given** 20 sequential calls to one host, **When** finished, **Then** the server accepted exactly 1 TCP connection (keep-alive reuse) and the client's idle timeout is shorter than the server's keep-alive timeout.
14. **AS-97** — **Given** a client limited to 2 concurrent calls with a wait queue of 2 and a 100 ms queue timeout, **When** 6 slow calls start together, **Then** 2 run, 2 wait, 2 fail at once with kind `bulkhead_full`; a different client (dependency) is unaffected.
15. **AS-98** — **Given** a breaker with window 10 s, minimum 20 calls, failure threshold 50 % and open duration 30 s, **When** 20 calls produce 12 failures (timeouts and 5xx), **Then** the state becomes OPEN; the next call fails at once with kind `circuit_open` without touching the network (`Retry-After` equals the remaining open time, rendered as `503` `dependency_unavailable`); **When** 30 s pass on the injected clock, **Then** it is HALF_OPEN and admits 3 trial calls; **When** all succeed, **Then** CLOSED; **When** one fails, **Then** OPEN again with a fresh 30 s timer.
16. **AS-99** — **Given** the breaker is HALF_OPEN with 3 trial calls in flight, **When** a 4th concurrent call arrives, **Then** it fails at once with kind `circuit_open`.
17. **AS-100** — **Given** a fallback registered on a call, **When** the breaker is OPEN, **Then** the fallback result is returned flagged `degraded: true` and the network is not touched; **When** the fallback itself throws, **Then** that error surfaces unchanged.
18. **AS-101** — **Given** breakers for dependencies A and B, **When** A opens, **Then** B's calls proceed; **Given** a run of `4xx` answers, **Then** they never count as failures and never open a breaker; calls slower than the slow-call threshold count as failures.
19. **AS-102** — **Given** a call with an `Authorization` header and a URL with `?token=abc`, **When** it is made and fails, **Then** the trace parent is sent to the server, `X-Request-Id` is sent only when the dependency is flagged internal, and neither the header value nor the query string appears in any log, span attribute or metric label (only the dependency name and the host).
20. **AS-103** — **Given** attempts `0..6`, base 100 ms, cap 5 000 ms, and a random source that returns `0`, `0.5`, `1`, **When** the full-jitter delay is computed, **Then** it equals `r × min(cap, base × 2^attempt)` for each, never negative, never above the cap.

### User Story 8 - User-supplied URLs cannot reach the inside (Priority: P1)

A domain engineer who must fetch or call a URL given by a user (competitor page, webhook endpoint, identity-provider metadata, store URL) calls one safe function that cannot be tricked into reaching a private address.

**Why this priority**: SSRF reaches cloud metadata credentials; four capabilities (S02, S08, S41, S43) depend on one guard.

**Independent Test**: An injectable resolver and a local server; assert that no connection is ever made to a blocked address.

**Acceptance Scenarios**:

1. **AS-104** — **Given** a resolver that maps `shop.example` to a public address and a local stand-in server reachable through the pinned address, **When** `safeGet("https://shop.example/page")` runs, **Then** it returns `{ status, headers, body, snippet, truncated: false, finalUrl, redirects: 0, durationMs }`.
2. **AS-105** — **Given** hosts resolving to `127.0.0.1`, `10.0.0.1`, `172.16.0.1`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0`, `224.0.0.1`, `198.18.0.1`, `::1`, `fc00::1`, `fe80::1`, `::ffff:127.0.0.1`, and URL literals `http://2130706433/`, `https://0x7f.0.0.1/`, `https://[::1]/`, `https://localhost/`, `https://LOCALHOST./`, **When** each is requested, **Then** each fails with kind `blocked_address`, and the stand-in server counted 0 connections.
3. **AS-106** — **Given** a host whose resolver answers one public and one private address, **When** requested, **Then** `blocked_address` (every address must pass).
4. **AS-107** — **Given** a resolver that answers a public address on the first lookup and `127.0.0.1` on any later lookup (rebinding), **When** the request runs, **Then** the connection goes to the first address, the resolver was called once per hop, and the certificate is verified against the original host name.
5. **AS-108** — **Given** a server answering `302`, **When** called with defaults, **Then** kind `redirect_refused`; **Given** `maxRedirects: 2` and `sameHostRedirectsOnly: true`, **Then** a same-host `302` is followed with the address re-checked; a redirect to another host fails `redirected_host`; a redirect to a host resolving privately fails `blocked_address`; a third redirect fails `too_many_redirects`.
6. **AS-109** — **Given** `http://shop.example/`, `https://shop.example:8443/`, `https://user:pw@shop.example/` and `ftp://shop.example/`, **When** requested with defaults (HTTPS only, allowed ports `[443]`), **Then** each fails `invalid_url` before any lookup; with `allowedPorts: [443, 8443]` the second is accepted.
7. **AS-110** — **Given** `NODE_ENV=production`, **When** a caller passes an option that permits plain HTTP or private hosts (a test-only escape hatch), **Then** the call throws a configuration error without any lookup; the same option works outside production.
8. **AS-111** — **Given** a server that sends one byte every 200 ms forever, **When** `requestDeadlineMs: 1 000` is set, **Then** the call fails `timeout` at about 1 s even though bytes keep arriving; **Given** a 3 MiB body and `maxBytes: 1 MiB`, **Then** the result has `truncated: true`, a body of at most 1 MiB and no failure.
9. **AS-112** — **Given** `allowedContentTypes: ["text/html"]` and a response of `application/octet-stream`, **When** requested, **Then** `unsupported_content_type` and the body is not buffered beyond the first chunk.
10. **AS-113** — **Given** a server whose certificate is valid for another host name, **When** requested, **Then** `tls_error` (verification is against the requested host name, not the pinned address).
11. **AS-114** — **Given** a resolver answering "no such host" and a server that resets the connection, **When** requested, **Then** `unresolvable` and `network_error` respectively; no failure message contains an address, a stack or response text.
12. **AS-115** — **Given** `safeRequest({ method: "POST", url, headers, body, timeoutMs, maxResponseBytes, allowedPorts: [443], followRedirects: false })` to a stand-in server, **When** it runs, **Then** the server receives the exact body and headers, the result has `status`, `snippet` (first 1 KiB of the response), `durationMs`, and a `3xx` answer is returned as a result (`redirects: 0`) rather than followed.

### User Story 9 - A retried POST never does its work twice (Priority: P1)

A client that retries a `POST` after a timeout gets the stored answer and no second side effect. Two parallel retries run the work once.

**Why this priority**: V.6 applies to orders, payments, payouts, bookings, bids, exports and imports; ten capabilities rely on one shared behaviour.

**Independent Test**: A test controller with a handler that counts executions and writes a row; real database; two app instances for the race.

**Acceptance Scenarios**:

1. **AS-116** — **Given** a route declared as requiring a key, **When** `POST` is sent with a new valid key and a body, **Then** the handler runs once and the response is stored; **When** the identical request is sent again, **Then** the same status and body come back with `Idempotency-Replayed: true`, the handler count is still 1 and the row count is 1.
2. **AS-117** — **Given** the first response carried `Location` and `Content-Type`, **When** replayed, **Then** both are present again, while `Set-Cookie` and `Date` of the original are not replayed.
3. **AS-118** — **Given** a handler that takes 1 s, **When** 10 requests with the same key arrive at once, **Then** exactly one handler ran, nine answered `409` `idempotency_in_flight` with `Retry-After: 1`, and a later request answers the stored response.
4. **AS-119** — **Given** a stored key, **When** a request reuses it with a different body, **Then** `422` `idempotency_key_reuse` and the handler does not run; **When** the body differs only in JSON key order and whitespace, **Then** it is treated as the same request and replayed.
5. **AS-120** — **Given** a stored key from `POST /shops/s1/deliveries`, **When** the same key is sent to `POST /shops/s2/deliveries`, or to the same path with a different query string, **Then** `422` `idempotency_key_reuse` (the fingerprint covers method, concrete path, sorted query and canonical body).
6. **AS-121** — **Given** a route that requires a key, **When** the header is missing, **Then** `422` `idempotency_key_required`; **When** it has 7 characters, 129 characters, a space, a non-ASCII character, or appears twice, **Then** `422` `idempotency_key_invalid`; **Given** `GET` with a key, **Then** it is ignored; **Given** a route not declared as idempotent, **Then** the header is ignored.
7. **AS-122** — **Given** users A and B send the same key text, **When** both run, **Then** both execute independently and each replay returns only its own caller's response; an API-key caller is scoped by API key ID, an anonymous caller by resolved client address.
8. **AS-123** — **Given** a stored record, **When** the clock is 23 h 59 min after the first request, **Then** it is replayed; **When** 24 h 1 s after, **Then** the key is treated as new and the handler runs again.
9. **AS-124** — **Given** a handler that fails body validation (`400` from the validation pipe), another that fails with `500`, a third that fails with a domain error not marked final (`409 stock_conflict`) and a fourth with a domain error marked `idempotencyFinal` (`422 out_of_stock`), **When** each is sent with a key and then resent with the same key, **Then** the first three release the key (the resend executes the handler again) and the fourth replays the stored `422`.
10. **AS-125** — **Given** a record claimed 90 s ago whose lock has expired (the first server died), **When** the same key arrives, **Then** it claims the key and runs; **Given** a lock still valid, **Then** `409` `idempotency_in_flight`.
11. **AS-126** — **Given** a response larger than 256 KiB, **When** stored, **Then** the record is completed without a body; **When** replayed, **Then** `409` `idempotency_replay_unavailable` and the handler does not run again.
12. **AS-127** — **Given** the database is unreachable, **When** a required-key request arrives, **Then** `503` `idempotency_unavailable` with `Retry-After: 1` and the handler did not run (fail closed).
13. **AS-128** — **Given** an unauthenticated request, a request rejected by the rate limiter, and a request that fails validation of the header, **When** each is sent with a fresh valid key, **Then** no record exists for the unauthenticated (`401`) and throttled (`429`) ones (the facility runs after guards and after throttling).
14. **AS-129** — **Given** records older than the TTL plus 1 h and records inside the TTL, **When** the purge job body runs, **Then** only the old records are removed, in batches of at most 1 000, and a second run removes nothing.
15. **AS-130** — **Given** two application instances on one database, **When** 20 requests with one key are sent with `Promise.all` split across both, **Then** exactly one handler ran in total.
16. **AS-131** — **Given** the ownership registry, **When** the static check runs, **Then** `IdempotencyKey` is owned by `infrastructure:idempotency`, no domain imports its model, and domains reach it only through the route declaration (constitution IX.3, IX.6).

### User Story 10 - Every app starts hardened and fails fast (Priority: P2)

An operator starts any app and gets the same security headers, CORS rules, client-address resolution, limits, validation, logs, metrics and configuration checks; a bad configuration never reaches traffic.

**Why this priority**: Consistency across `core`, `bff`, `public-api` and the rest; every capability assumes it.

**Independent Test**: Boot the test app with different configurations; assert headers, failures and logs.

**Acceptance Scenarios**:

1. **AS-132** — **Given** the production configuration, **When** any response (success, `404`, `500`, probe) is returned, **Then** it has `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-site`, `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` and `Strict-Transport-Security: max-age=31536000; includeSubDomains`, and no `X-Powered-By`; in `test` and `local` HSTS is absent.
2. **AS-133** — **Given** a route group declared with the `public-embed` policy by its owner, **When** called from any origin, **Then** it answers `Access-Control-Allow-Origin: *` without credentials and `Cross-Origin-Resource-Policy: cross-origin`; every other route keeps the strict policy.
3. **AS-134** — **Given** an allowlist of `https://app.example`, **When** a request with that `Origin` arrives, **Then** `Access-Control-Allow-Origin` echoes it with `Vary: Origin`, credentials allowed, and `Access-Control-Expose-Headers` listing `X-Request-Id`, `Retry-After`, `RateLimit`, `RateLimit-Policy`, `ETag`, `Idempotency-Replayed`, `Deprecation`, `Sunset`, `Link`; **When** the `Origin` is `https://evil.example`, **Then** no CORS header is returned; **When** a preflight from the allowed origin asks for `Idempotency-Key`, `Authorization`, `Content-Type`, `X-Request-Id`, `If-Match`, **Then** the answer allows them with `Access-Control-Max-Age: 600`.
4. **AS-135** — **Given** production configuration with an empty allowlist, or `*` together with credentials, **When** the app starts, **Then** startup fails naming the key; in `local` and `test` an empty allowlist reflects any origin.
5. **AS-136** — **Given** trusted proxies `10.0.0.0/8`, **When** a peer `203.0.113.9` (untrusted) sends `X-Forwarded-For: 1.2.3.4`, **Then** the client address is `203.0.113.9`; **When** peer `10.0.0.2` sends `X-Forwarded-For: 6.6.6.6, 9.9.9.9, 10.0.0.7`, **Then** it is `9.9.9.9` (the first untrusted address from the right; the forged leftmost value is ignored); **When** the header is `garbage, 10.0.0.7`, **Then** it falls back to the peer; `::ffff:9.9.9.9` is normalised to `9.9.9.9`.
6. **AS-137** — **Given** production configuration without a trusted-proxy setting, **When** the app starts, **Then** startup fails; an explicit `none` starts and trusts no forwarding header.
7. **AS-138** — **Given** a body limit of 1 MiB, **When** a signed webhook body `{"b": 1,   "a": 2}` is posted, **Then** the exact received bytes are available to the handler and an HMAC computed over them verifies, even though a re-serialised body would not; **When** the body is 1 MiB + 1 byte, **Then** `413` and no raw bytes are retained.
8. **AS-139** — **Given** a JSON response of 5 KiB and `Accept-Encoding: gzip`, **When** requested, **Then** it is compressed with `Vary: Accept-Encoding`; a 200-byte response, a `text/event-stream` response and a response with `Cache-Control: no-transform` are never compressed.
9. **AS-140** — **Given** a probe route that records which stages ran, **When** requests with each failing condition arrive (overloaded; disallowed origin plus bad body; unauthenticated plus bad body; authenticated, throttled and bad body; authenticated and bad body), **Then** the outcomes are: shed `503`; CORS headers absent and the pipeline continues; `401` (guard before pipe, handler not run); `429` (limiter before idempotency and before pipes); `400` `validation_failed`; and the recorded stage order is: request context, load shedding, security headers and CORS, client address, body parsing, guards, metrics interceptor, rate limit, idempotency, validation pipe, handler, exception filter.
10. **AS-141** — **Given** a configuration with 4 invalid keys (one a secret whose value is `s3cr3t-value`), **When** the app starts, **Then** the single failure message lists all 4 keys with their reasons, contains no value, and the string `s3cr3t-value` appears in no log line of the run.
11. **AS-142** — **Given** capability-registered rules (a client ID without its secret; a redirect base that is not HTTPS and not localhost; `usercontent_origin` equal to the app origin in production; two secrets with identical values; a secret shorter than 32 characters in production), **When** each violating configuration is started, **Then** startup fails naming the rule; each satisfying configuration starts.
12. **AS-143** — **Given** `platform_currency` set to `usd`, `US`, `USDX` and `EUR`, **When** the app starts, **Then** the first three fail and `EUR` is readable through the platform settings as `EUR`; the platform settings also expose `appOrigin` and `usercontentOrigin` read from validated configuration.
13. **AS-144** — **Given** `db_pool_max = 20`, `max_instances = 10`, `db_connection_limit = 150`, **When** the app starts, **Then** it fails stating `20 × 10 = 200 > 150`; with `max_instances = 7` it starts (constitution III.12).
14. **AS-145** — **Given** a running app, **When** a pooled connection is inspected, **Then** `statement_timeout` is 30 000 ms, `idle_in_transaction_session_timeout` is 30 000 ms and `application_name` equals the service name; **Given** a pool of 2 with 3 concurrent long transactions, **When** the third waits longer than the acquire timeout (3 s; 300 ms in the test), **Then** it fails with `503` `database_unavailable` and `Retry-After: 1` instead of hanging.
15. **AS-146** — **Given** `database_replica_url` is set, **When** a service reads through the replica handle, **Then** reads work and a write is rejected by the session (read-only); **Given** production and a configuration that disables certificate verification, **Then** startup fails; the production replica connection options always verify the certificate.
16. **AS-147** — **Given** any request, **When** it completes, **Then** exactly one JSON access-log line exists with `requestId`, `traceId` (when traced), `route` (the template), `method`, `status`, `durationMs`, with no query string, no body and no `authorization`, `cookie`, `x-api-key`; every other log line of the request carries `requestId`.
17. **AS-148** — **Given** a log object `{ ctx: { user: { password: "p", profile: { refreshToken: "r", note: "ok" } } }, headers: { Authorization: "Bearer x", "x-api-key": "k", cookie: "c" }, token: "t", secret: "s" }`, **When** it is logged, **Then** every value under the keys `password`, `refreshToken`, `token`, `secret`, `authorization`, `x-api-key`, `cookie`, `set-cookie` at any depth reads `[REDACTED]` (matched case-insensitively) and `note` is untouched; strings containing a newline are emitted as one JSON line.
18. **AS-149** — **Given** a metric registered with label `userId`, `shopId`, `requestId`, `email`, `ip`, `url` or `path`, **When** the app starts, **Then** startup fails naming the metric and the label; **Given** two registrations of one name with different types or labels, **Then** startup fails; **Given** identical registrations, **Then** they share one instrument; names must be lowercase snake case with a unit suffix (`_seconds`, `_bytes`, `_total`, `_ratio`) or be gauges named for what they count.
19. **AS-150** — **Given** requests to 3 000 distinct unmatched paths, **When** the metrics endpoint is scraped, **Then** they all fall into one `route="unmatched"` series (not 3 000); the request-duration histogram carries only method, route template and status class; the metrics endpoint answers on its own port and `GET /metrics` on the public port is `404`; a metric that exceeds 2 000 distinct label sets puts the excess into one overflow series.
20. **AS-151** — **Given** a fake clock set to a fixed instant, **When** the idempotency TTL, the health cache, the circuit breaker, the retry budget window and the startup deadline are exercised, **Then** all read that clock; a static check finds no direct wall-clock read in `domain/` code of the toolkit's pure logic (constitution I.3).
21. **AS-152** — **Given** the application starts normally, **When** the startup log is inspected, **Then** it prints the names of configuration keys loaded and which are secret (as `[set]`) but never a secret's value, a connection string with credentials, or an API key.

### Edge Cases

- A request arrives exactly as shutdown begins: it is either served (accepted before the server stops) or refused at the connection (AS-57); never half-answered.
- A consumer message and an HTTP request run in the same process: contexts never mix (AS-19, AS-22).
- A transaction is open when the process receives SIGTERM: it is drained like any in-flight request (AS-60).
- A readiness check throws synchronously rather than returning a rejected promise: reported `down` (AS-48 covers the hang; the sync throw is part of the same table row).
- Two capabilities register tasks at the same shutdown order: they run concurrently (AS-64).
- A client sends a very long `X-Request-Id`, a header with control characters, or two copies of the header: replaced (AS-18).
- A `Retry-After` of zero: retried after jitter, not instantly in a tight loop (AS-87 table).
- The retry budget has headroom but the circuit breaker is open: the breaker wins; no retry is attempted (AS-98).
- A fallback or degradation path (breaker open, shed load, store outage) is forced by a test, per VII.9: AS-100, AS-74, AS-127.
- Idempotency key reuse across tenants or users is not a collision (AS-122); a replay never returns another principal's response.
- A stored idempotent response is larger than the cap: replay is refused with `409`, never re-executed (AS-126).
- Clock skew between replicas: idempotency lock expiry and the TTL use the shared store's clock via the injected clock only for comparisons made in one process; replicas are assumed NTP-synchronised within 1 s and the minimum lock is 60 s (Assumptions).
- Probe paths requested through a path that carries the global prefix (`/api/health/live`) are not served (AS-51); the probes are not aliased under the prefix.
- A `HEAD` request to a probe is answered like `GET` without a body (AS-51).

## Requirements *(mandatory)*

### Functional Requirements

**Errors (US1)**

- **FR-001**: Every error response MUST be `application/problem+json` produced by one global filter, with members `type`, `title`, `status`, `detail`, `instance`, `code`, `requestId` and `traceId` when a trace is active, and never any other platform member (AS-01, AS-15).
- **FR-002**: Each problem MUST have a stable snake-case `code` from a registry; the `type` is `<configured base URL>/<code>`; a thrown error without a registered code renders as `internal_error` (AS-01, AS-02).
- **FR-003**: For every status `>= 500` the `detail` MUST be the fixed catalogue text of the code; thrown messages, wrapped causes, SQL, upstream text and stack traces never reach the body in any environment (AS-02, AS-03, AS-04).
- **FR-004**: Errors MUST be classified as operational (expected, mapped to its status, logged at `warn` without stack) or programmer (unexpected, `500`, logged at `error` with stack and cause chain and reported to the error tracker) (AS-02, AS-11).
- **FR-005**: Framework and transport failures (validation, malformed body, oversized body, wrong media type, unmatched route, wrong method, `401`, `403`) MUST be rendered by the same filter with the codes `validation_failed`, `malformed_body`, `payload_too_large`, `unsupported_media_type`, `not_found`, `method_not_allowed`, `unauthenticated`, `forbidden`; headers set by the thrower (`WWW-Authenticate`, `Allow`, `Retry-After`) are preserved (AS-05 to AS-08, AS-10).
- **FR-006**: Validation failures MUST list every failing field as `{field, code}` at once and never echo an input value (AS-05).
- **FR-007**: A raw database unique violation MUST render as `409` `conflict` with generic text and no column, constraint or value; domain flows that need a specific outcome map it themselves (anti-enumeration, P0506) (AS-09).
- **FR-008**: Extension members and `Retry-After` MUST be supported on problems; extensions MUST NOT be able to override a reserved member (AS-10).
- **FR-009**: Two registrations of the same `code` with different definitions MUST fail startup, naming both owners (AS-12).
- **FR-010**: Problems for routes with a sensitive path parameter MUST use the route template in `instance` and in logs (AS-14).
- **FR-011**: The filter MUST NOT write after headers are sent and MUST NOT throw; if rendering fails it MUST fall back to a minimal `500` problem (AS-13, AS-16).
- **FR-012**: The problem-details schema MUST be exported from the contracts package, and every error response of the platform MUST parse against it (AS-15).

**Request context (US2)**

- **FR-013**: Every HTTP request, consumer message and job run MUST execute inside its own isolated context carrying `requestId`, `principalType`, and optionally `userId`, `shopId`, `roles`, `clientIp`, `traceparent`, `deadlineAt` (AS-17, AS-19, AS-22).
- **FR-014**: An inbound `X-Request-Id` MUST be accepted only when it is 8 to 128 characters of letters, digits, `.`, `_`, `-` and appears once; otherwise a UUIDv7 MUST be generated; the ID MUST be returned in the response header and carried in every log line, error body and event envelope (AS-17, AS-18, AS-24).
- **FR-015**: Once `shopId` is set in a context it MUST NOT change to a different value; the attempt is a programmer error (AS-21).
- **FR-016**: Reading the context outside a run MUST return `undefined` without throwing (AS-23).
- **FR-017**: The context MUST offer a copyable `snapshot()` for event envelopes and a per-context `memo` for request-scoped helpers (AS-24, AS-25).
- **FR-018**: No provider may use request scope; context travels only by the context mechanism (constitution II.4) (AS-26).
- **FR-019**: Capabilities MUST be able to add typed context fields without editing the toolkit, and undeclared keys MUST fail compilation (P0114) (AS-27).

**Transactions (US3)**

- **FR-020**: The toolkit MUST provide one transaction scope (explicit `run` and a method decorator for application services) in which every model call joins the active transaction without a transaction argument; nested scopes join by default and may ask for a new transaction (AS-28, AS-31, AS-32).
- **FR-021**: A scope MUST commit on success and roll back everything on any error, rethrowing it unchanged (AS-29).
- **FR-022**: `afterCommit` callbacks MUST run once, after commit, in registration order, never on rollback; a failing callback is logged and affects nothing else (AS-29, AS-30).
- **FR-023**: Concurrent scopes MUST NOT share a transaction, and code after a scope ends MUST run outside it (AS-33, AS-34).
- **FR-024**: A serializable scope MUST retry serialization failures and deadlocks with full-jitter backoff up to 3 attempts total and MUST NOT retry any other error; exhaustion renders `503` `transaction_conflict` with `Retry-After: 1` (AS-35, AS-36).
- **FR-025**: Per-scope statement and lock timeouts MUST be integers from 1 to 600 000 ms, validated before use, never interpolated from request data; a statement timeout renders `503` `database_timeout`, a lock timeout `503` `db_lock_timeout` (AS-37, AS-38).
- **FR-026**: `getActiveTransaction()` and `assertActiveTransaction()` MUST exist for consumers such as the outbox (AS-39).
- **FR-027**: The outbound HTTP client and the SSRF-safe functions MUST refuse to send while a transaction is active in the context, count the attempt in `network_call_in_transaction_total`, and work from `afterCommit` (AS-40).

**Probes (US4)**

- **FR-028**: The app MUST serve `/health/live`, `/health/ready` and `/health/startup` outside the global prefix, unauthenticated, never rate-limited, never shed, never access-logged at `info`, excluded from request metrics, with `Cache-Control: no-store`, for `GET` and `HEAD` (AS-51).
- **FR-029**: Liveness MUST depend only on in-process state: it fails only when the event-loop p99 exceeds the liveness threshold (default 10 000 ms) or a registered heartbeat is silent beyond its limit; it MUST NOT touch any external store and MUST stay `200` during shutdown (AS-41, AS-47, AS-52, AS-53).
- **FR-030**: Heartbeats MUST be registerable and unregisterable (the consumer-stop task unregisters its heartbeat) (AS-53).
- **FR-031**: Readiness MUST be `503` when the app has not finished startup, when shutdown has begun, or when a pod-local critical check fails; checks MUST be classified `pod` or `shared`; shared checks are reported but never fail readiness unless promoted to critical with a `failureThreshold` (AS-42 to AS-44).
- **FR-032**: Startup MUST be `503` until all registered warm-up work finishes and never regress afterwards (AS-45, AS-46).
- **FR-033**: Each check MUST have a timeout (default 500 ms) shorter than the probe timeout, receive an abort signal, and report `down` on timeout or throw (AS-48).
- **FR-034**: Check results MUST be cached for a short TTL (default 2 s) and concurrent evaluations MUST share one in-flight run (AS-49).
- **FR-035**: Probe bodies MUST list check names and `up`/`down` only; error text goes to logs and the gauge `health_check_up{check}` (AS-50, AS-55).
- **FR-036**: Apps with no HTTP surface MUST expose the probes on a configured management listener (AS-54).
- **FR-037**: The gauge `platform_ready` MUST be `1` when readiness would answer `200`, else `0` (AS-55).

**Shutdown (US5)**

- **FR-038**: On SIGTERM or SIGINT the app MUST run this sequence once: mark not-ready; keep serving for the drain delay; stop accepting connections and close idle keep-alive sockets (answering requests on busy sockets with `Connection: close`); let in-flight requests finish up to the request-drain timeout and then destroy their sockets; run registry tasks in ascending order; flush telemetry; exit `0`. A second signal is ignored (AS-56 to AS-59, AS-63).
- **FR-039**: The registry MUST run tasks only after the HTTP drain, in ascending `order`; tasks with equal order run concurrently; every task has a timeout; a failing or timed-out task is logged and the sequence continues; any failure makes the exit code `1`; registration after shutdown began is rejected (AS-60, AS-61, AS-64).
- **FR-040**: A task registered with phase `drain` MUST run during the HTTP drain, concurrently with it (for long-lived connections) (AS-65).
- **FR-041**: A hard timeout MUST end the process with code `1` and a `forced shutdown` log if the sequence is still running (AS-62).
- **FR-042**: `unhandledRejection` and `uncaughtException` MUST write the cause synchronously to stderr and to the log, then exit `1` within 2 s without draining; the process MUST never continue (AS-66).
- **FR-043**: Startup MUST validate configuration first and fail fast (exit `1`, before listening); connect to dependencies with bounded jittered retry up to a startup deadline; and MUST NOT run migrations or schema sync (AS-70, AS-71).
- **FR-044**: Shutdown timings MUST be validated (`drain + request drain < hard timeout`); server timeouts MUST be keep-alive 65 000 ms, headers 66 000 ms, and a request timeout; keep-alive at or below 60 000 ms MUST fail startup in production (AS-67, AS-68).
- **FR-045**: The image MUST run under an init process in exec form with `SIGTERM` as stop signal and leave grace-period headroom (AS-69).
- **FR-046**: Apps without HTTP MUST use the same sequence minus the HTTP steps (AS-72).
- **FR-047**: Exactly one handler owns process signals; the framework's own signal hooks MUST NOT also run the sequence (AS-63).

**Load shedding (US6)**

- **FR-048**: The toolkit MUST sample event-loop delay every second, publish the p99 of the latest window as `nodejs_eventloop_lag_p99_ms`, and use only that window (AS-73, AS-83).
- **FR-049**: Every route MUST have a priority (`critical`, `default`, `background`; default `default`); with threshold `T` (default 200 ms) background is shed at lag `>= T`, default at `>= 2T`, critical at `>= 5T`; probes and the metrics endpoint are never shed (AS-75, AS-76).
- **FR-050**: Shedding MUST stop only after two consecutive samples below `0.8 × tier threshold` (AS-77).
- **FR-051**: An in-flight cap (default 1 000 per instance) MUST shed background and default requests at the cap and critical at twice the cap; the counter MUST be released on finish and on abort (AS-78, AS-79).
- **FR-052**: A shed response MUST be `503` `service_overloaded` problem+json with `Retry-After` (integer 1 to 3, randomised), `X-Request-Id` and `Connection: close`, decided before body parsing, authentication, rate limiting and logging; the handler never runs (AS-74, AS-81).
- **FR-053**: Shedding MUST count in `http_requests_shed_total{priority}` and log at most one `warn` line per second with the count (AS-82).
- **FR-054**: If the monitor is unavailable the toolkit MUST fail open (AS-83).

**Resilient HTTP (US7, US8)**

- **FR-055**: The client MUST apply a connect timeout (default 3 s), a per-attempt timeout, an overall deadline and the request context's deadline (the smallest wins), and release sockets on every outcome (AS-84, AS-91, AS-92).
- **FR-056**: Retries MUST happen only for idempotent calls (safe methods by default, others only when declared) and only for transient failures (timeouts, resets, refusals, `408`, `425`, `429`, `502`, `503`, `504`), at most 3 attempts in total in the synchronous profile (6 in `background`), with full-jitter backoff (base 100 ms, cap 5 s), honouring `Retry-After` only up to the remaining budget (AS-85 to AS-89, AS-103).
- **FR-057**: A retry budget per dependency host MUST cap retries at 10 % of requests per 10 s window with a floor of 10, and count exhaustion (AS-90).
- **FR-058**: The client MUST cap response size (default 1 MiB), reject invalid JSON, never follow redirects by default, reuse connections with an idle timeout below the server's, and bound concurrency per dependency with a bounded wait queue (AS-93 to AS-97).
- **FR-059**: A generic circuit breaker MUST implement CLOSED, OPEN and HALF_OPEN with a rolling window, minimum calls, failure-rate threshold, slow-call counting, an open duration, a bounded number of half-open trials, an injected clock, a per-dependency instance, an optional fallback marked `degraded`, and state and transition metrics; `4xx` answers never count as failures (AS-98 to AS-101).
- **FR-060**: The client MUST propagate the trace parent, send `X-Request-Id` only to dependencies flagged internal, and never log header values or query strings (AS-102).
- **FR-061**: The SSRF-safe functions MUST allow only HTTPS to allowed ports (default `[443]`) without URL credentials; resolve the host; reject unless every address is public; connect only to the checked address with certificate verification against the requested host; re-check on each redirect; refuse redirects by default; enforce an overall deadline and a byte cap; optionally filter content type; and report typed failures `blocked_address | unresolvable | invalid_url | redirect_refused | redirected_host | too_many_redirects | unsupported_content_type | timeout | tls_error | network_error` (AS-104 to AS-115).
- **FR-062**: Insecure or private-host escape hatches of the SSRF-safe functions MUST be refused when `NODE_ENV=production` (AS-110).

**Idempotency (US9)**

- **FR-063**: A route declared idempotent MUST implement: required-key check (`422 idempotency_key_required`), format check (`422 idempotency_key_invalid`; 8 to 128 characters of letters, digits, `_`, `-`; one header only), per-principal scope, a fingerprint of method, concrete path, sorted query and canonical body, atomic claim, in-flight `409 idempotency_in_flight` with `Retry-After: 1`, different-fingerprint `422 idempotency_key_reuse`, stored replay with `Idempotency-Replayed: true`, TTL 24 h (route override up to 7 days) (AS-116 to AS-123).
- **FR-064**: All time comparisons in the toolkit (idempotency TTL and lock expiry, health cache, breaker, retry budget, startup deadline) MUST read the injected clock (AS-151).
- **FR-065**: Failed requests MUST release the key unless the error is marked `idempotencyFinal`; the facility's own `409` and `422` are never stored (AS-124).
- **FR-066**: A claim MUST expire after a lock time (default 60 s) so a dead instance does not block a key forever; responses over 256 KiB are stored without a body and replay as `409 idempotency_replay_unavailable` (AS-125, AS-126).
- **FR-067**: When the store is unavailable the facility MUST fail closed with `503 idempotency_unavailable` (AS-127).
- **FR-068**: The facility MUST run after authentication and rate limiting and before validation (AS-128, AS-140).
- **FR-069**: Records MUST live in one technical table owned by `infrastructure:idempotency` and be purged by a scheduled job in batches (AS-129, AS-131); a claim MUST be atomic across instances (AS-130).

**Bootstrap (US10)**

- **FR-070**: Every response MUST carry the security headers of AS-132; a route group may opt into a named relaxed policy (`public-embed`) declared by its owner (AS-132, AS-133).
- **FR-071**: CORS MUST use a strict allowlist, expose the headers of AS-134, allow `Idempotency-Key` and the other listed request headers, and in production fail startup on an empty allowlist or wildcard with credentials (AS-134, AS-135).
- **FR-072**: The client address MUST be resolved from the forwarding header only through the trusted-proxy chain (first untrusted address from the right), exposed as `request.clientIp` and in the context; production MUST require an explicit trusted-proxy setting (AS-136, AS-137).
- **FR-073**: Request bodies MUST be limited (default 1 MiB, `413`); the exact received bytes MUST be available to signature-verifying handlers (AS-138).
- **FR-074**: JSON responses over 1 KiB MUST be compressed when accepted, except event streams and `no-transform` responses (AS-139).
- **FR-075**: The validation pipe MUST reject unknown properties and transform types (`whitelist`, `forbidNonWhitelisted`, `transform`) (AS-05).
- **FR-076**: The pipeline MUST follow the fixed order of AS-140 in every app that uses the bootstrap.
- **FR-077**: Configuration MUST be schema-validated at startup, report every invalid key at once without values, support capability-registered rules, validate cross-field rules (pool arithmetic, shutdown timings, origins, paired secrets, secret length and distinctness in production), expose `platform_currency` (ISO 4217, three uppercase letters), `appOrigin` and `usercontentOrigin`, and never print secrets (AS-141 to AS-144, AS-152).
- **FR-078**: Database connections MUST set `statement_timeout`, `idle_in_transaction_session_timeout` and `application_name`; the pool MUST have an acquire timeout that fails fast with `503 database_unavailable`; a read-replica handle MUST exist when configured, read-only, with certificate verification in production (AS-145, AS-146).
- **FR-079**: Logs MUST be structured JSON with one access line per request and `requestId`/`traceId` on every line, redact secret-bearing keys at any depth, and never log bodies or query strings (AS-147, AS-148).
- **FR-080**: The metrics registry MUST reject forbidden labels and conflicting duplicates, label routes by template (unmatched paths as `unmatched`), cap series per metric at 2 000 with an overflow series, and serve metrics only on a non-public port (AS-149, AS-150).

### Key Entities

- **Problem document**: the single error shape (members above), plus the **problem code registry** (code, status, title, safe detail, owner capability).
- **Request context**: per-unit-of-work store of `requestId`, `principalType`, `userId`, `shopId`, `roles`, `clientIp`, `traceparent`, `deadlineAt`, and the active transaction handle.
- **Transaction scope**: an atomic unit with joined or new nesting, timeouts, `afterCommit` hooks and a retry policy for serialization failures.
- **Probe report**: `status`, optional `reason`, and a map of check name to `up`/`down`; checks have a scope (`pod` or `shared`), a critical flag, a failure threshold and a timeout; heartbeats have a maximum silence.
- **Shutdown task**: name, order, phase (`drain` or `stop`), timeout, action.
- **Route priority**: `critical`, `default` or `background`.
- **Dependency client**: a named outbound client with its pool, budget, bulkhead and breaker; **circuit breaker** state and counters.
- **Idempotency record**: principal scope, key, fingerprint, state (`in_flight`, `completed`), lock expiry, stored status, headers and body, expiry.
- **Metric definition**: name, type, allowed labels, owner.
- **Configuration rule**: owner, keys, predicate, message.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across a sample of 10 000 error responses from every kind of failure in this spec, 100 % parse as the problem document, 0 contain a stack line, SQL text, table name or upstream message, and 100 % carry the same request ID as their header.
- **SC-002**: During 20 consecutive rolling restarts of an instance under steady load, 0 requests that were accepted are dropped or answered with a connection error, and every instance exits within the grace period.
- **SC-003**: At 2× the instance's measured capacity, admitted requests keep a p99 under 300 ms, 100 % of refused requests are `503` with `Retry-After`, and probe requests are never refused.
- **SC-004**: During a 60 s database outage, 100 % of instances keep answering readiness `200` and the platform returns fast `503` problems for database-backed routes rather than removing every instance from service.
- **SC-005**: With a dependency failing 100 % of the time, extra traffic produced by retries stays at or below 10 % of the request volume (plus the floor), and no single call takes longer than its deadline.
- **SC-006**: 1 000 parallel requests with one idempotency key produce exactly one side effect and 999 replays or `409` answers; 0 duplicates after any retry within 24 h.
- **SC-007**: A suite of at least 40 SSRF payloads (private ranges, encodings, rebinding, redirects) produces 0 connections to any non-public address.
- **SC-008**: The context and logging overhead stays under 0.5 ms p99 per request.
- **SC-009**: 100 % of tested misconfigurations (bad key, missing pair, weak secret, conflicting timings, wild CORS, missing proxy setting in production) stop the app before it serves traffic, and none leaks a secret value.
- **SC-010**: A new capability can add a domain error, a probe check, a shutdown task, an outbound client and an idempotent route using only the names listed under Provides, without changing any toolkit file.

## Assumptions

- **Decision policy**: showcase codebase with no external clients to keep compatible; where the notes and today's code disagree the notes win and the most production-grade option is chosen. Every such choice is in `questions.md`, tagged by impact.
- **Probes stay on the application's main listener** for apps that have one (the load balancer's target-group check points there). They carry no internal detail (AS-50), and the public edge is configured, outside this spec, not to route `/health/live`, `/health/ready`, `/health/startup` or `/metrics`.
- **Shared dependencies never fail readiness by default.** Postgres, the cache and the broker are `shared` checks (notes 08/01 §3). A deployment that wants the opposite promotes a check to critical with a failure threshold (AS-44).
- **Problem base URL** is a validated configuration key (`problem_type_base_url`); the code placeholder `api.yourdomain.com` goes away.
- **Time**: replicas are assumed NTP-synchronised within 1 s; the minimum idempotency lock is 60 s and the minimum token or lease windows used by the toolkit are much larger than the skew.
- **Numbers**: grace period (deploy) 45 s; drain delay 5 s (production), 0 elsewhere; request-drain timeout 15 s; hard timeout 25 s; probe periods and timeouts of the notes (§4 of 08/01) are the targets the numbers above are chosen for. Event-loop shedding threshold 200 ms; in-flight cap 1 000; liveness event-loop threshold 10 000 ms; readiness check timeout 500 ms; cache TTL 2 s.
- **The idempotency store is a database table, not the cache.** Idempotency records must survive cache eviction and failover to protect money paths; the table is on the IX.3 allowlist (idempotency keys), so no amendment is needed. The `IdempotencyKey` registry entry is added in the implementing PR.
- **The circuit breaker is a pure, clock-injected primitive** in the common layer (no I/O), so S13, S43 and S46 reuse it and the Stripe client's own breaker migrates to it.
- **One failure-kind vocabulary** for outbound calls: the union in FR-061 and the client kinds `timeout`, `aborted`, `status`, `response_too_large`, `invalid_response`, `bulkhead_full`, `circuit_open`, `retry_after_exceeds_budget`, `budget_exhausted`.
- **Raw-body capture** keeps the exact bytes of every JSON or form body up to the body limit; the memory cost (one extra copy of at most 1 MiB per in-flight request) is accepted so signature-verifying routes need no special mounting.
- **No cross-domain data is read.** The toolkit reads no other domain's tables (constitution IX.4); the only external data it consumes is what guards put into the context (identity, tenancy), which is not a data read, so none of R1, R2 or R3 is needed.
- **Scope extensions from sibling specs** (accepted because the owning capability asked S54 and none else owns them): the idempotency facility (S06, S07, S10, S13, S15, S19, S20, S22, S27, S37, S42, S43, S53 name S54), the SSRF-safe client (S02, S08, S41, S43), the generic breaker (S13, S43, S46), config keys `platform_currency` and `usercontent_origin` (S05/S08, S31), the replica handle (S16), compression (S51).
- **Metric names of other capabilities** (S29, S30, S49, S50, S52) are registered by those capabilities through the registry; the toolkit enforces the naming and label rules only.
- **Domain-map note**: `health`, `lifecycle`, `platform`, `context`, `http-client`, `net`, `idempotency` are infrastructure libs; the generic errors, filter, config, logging, telemetry, load shedding, clock and the new `resilience` (circuit breaker) are common libs.

## Cross-capability contracts

### Provides

All names are exact; paths are the public entry points (constitution X.4).

- **Problem errors** (`@app/common/errors`, `@app/common/exceptions-filter`): `AppError` constructor parameters `{ code: string; status: number; title: string; detail: string; extensions?: Record<string, JsonValue>; retryAfterSeconds?: number; idempotencyFinal?: boolean; headers?: Record<string, string>; area; causes? }`; subclasses keep the `Fatal_`, `Domain_`, `Transient_` prefixes and now require `code`. `ProblemCatalogModule.forFeature(entries: { code, status, title, detail }[])` registers a capability's codes (AS-12). The global `AllExceptionsFilter` renders them. Guarantees: members and rules of FR-001 to FR-011.
- **Contract schema** (`packages/contracts/problem.ts`): `problemDetailsSchema` (zod) and the inferred `ProblemDetails` type; members as FR-001; `errors?: { field: string; code: string }[]` for `validation_failed`.
- **Platform codes** (owned here): `internal_error`, `bad_request`, `validation_failed`, `malformed_body`, `payload_too_large`, `unsupported_media_type`, `not_found`, `method_not_allowed`, `unauthenticated`, `forbidden`, `conflict`, `service_overloaded` (503), `dependency_unavailable` (503), `transaction_conflict` (503), `database_timeout` (503), `db_lock_timeout` (503), `database_unavailable` (503), `idempotency_key_required` (422), `idempotency_key_invalid` (422), `idempotency_key_reuse` (422), `idempotency_in_flight` (409), `idempotency_replay_unavailable` (409), `idempotency_unavailable` (503).
- **Request context** (`@app/infrastructure/context` for the service; `@app/common/request-context` for the types `AppClsStore`, `REQUEST_ID_HEADER`): `RequestContext` with `run(initial: Partial<AppClsStore>, fn: () => Promise<T>): Promise<T>` (S49 passes `{ requestId, shopId?, principalType, traceparent? }`), getters `requestId`, `userId`, `shopId`, `roles`, `principalType`, `clientIp`, `traceparent`, `deadlineAt`, `isActive()`, `set(key, value)`, `snapshot(): { requestId, traceparent?, userId?, shopId?, principalType }`, `memo<T>(key: symbol, factory: () => T): T`. Guarantees: FR-013 to FR-019. Callers: guards set `userId`, `principalType`, `roles`; the tenancy guard sets `shopId` only after membership is verified (S01, S03).
- **Transactions** (`@app/infrastructure/context`): `TransactionRunner.run(fn, options?: { isolationLevel?, lockTimeoutMs?, statementTimeoutMs?, propagation?: 'join' | 'requires_new' })`, `TransactionRunner.runSerializable(fn, options?: { maxAttempts?: number /* ≤ 3 */ })`, decorator `@Transactional(options?)`, `getActiveTransaction(): Transaction | undefined`, `assertActiveTransaction(): Transaction` (used by `outbox.append`, S53), `afterCommit(fn: () => void | Promise<void>): void`. Guarantees: FR-020 to FR-027.
- **Probes** (`@app/infrastructure/health`): `ReadinessService.register({ name, scope: 'pod' | 'shared', critical?: boolean, failureThreshold?: number, timeoutMs?: number, check: (signal: AbortSignal) => Promise<void> })`, `LivenessService.registerHeartbeat(name, maxSilenceMs): { beat(): void; unregister(): void }`, `StartupService.addWarmup(name, fn)`. Endpoints `GET|HEAD /health/live`, `/health/ready`, `/health/startup`. Guarantees: FR-028 to FR-037. S52 registers its store as `shared`; S53 and S49 register consumer and scheduler heartbeats.
- **Shutdown** (`@app/infrastructure/lifecycle`): `ShutdownRegistry.register({ name, order, phase?: 'drain' | 'stop', run, timeoutMs? })`, bands: 10 stop intake (consumers, pollers, schedulers), 30 end long-lived work, 50 flush buffers, 80 caches and toolkits, 90 close pools and clients, 95 telemetry; `installGracefulShutdown`, `installCrashHandlers`. Guarantees: FR-038 to FR-047 (S51 uses phase `drain`; S52 uses order 80).
- **Load shedding** (`@app/common/load-shedding`): `@LoadSheddingPriority('critical' | 'default' | 'background')`, `EventLoopMonitor.p99Ms()`; metrics `nodejs_eventloop_lag_p99_ms`, `http_requests_shed_total{priority}`. Guarantees: FR-048 to FR-054.
- **Resilient HTTP** (`@app/infrastructure/http-client`): `ResilientHttpClient.create({ name, internal?: boolean, maxConcurrent?, breaker?, retry?: { profile?: 'sync' | 'background'; maxAttempts?; } })` with `requestJson<T>(url, { method?, headers?, body?, timeoutMs?, deadlineAt?, idempotent?, maxAttempts?, maxResponseBytes?, signal?, fallback? }) → { status, headers, body, degraded?: boolean }`; error `HttpClientError { kind, status?, attempts, retryable }` with kinds of Assumptions. Guarantees: FR-055 to FR-060.
- **Circuit breaker** (`@app/common/resilience`): `CircuitBreaker({ name, clock, windowMs, minimumCalls, failureRateThreshold, slowCallMs?, openDurationMs, halfOpenCalls })` with `execute(fn, { fallback? })`, `state()`; metrics `circuit_breaker_state{dependency}` and `circuit_breaker_transitions_total{dependency,to}`. Pure, clock-injected (S13, S43, S46 reuse).
- **SSRF-safe requests** (`@app/infrastructure/net`): `safeGet(url, { userAgent, maxBytes, requestDeadlineMs, maxRedirects, sameHostRedirectsOnly, allowedPorts, allowedHosts?, allowedContentTypes?, resolver? })` and `safeRequest({ method, url, headers?, body?, timeoutMs, maxResponseBytes, allowedPorts, followRedirects, resolver? })`, both resolving to `{ status, headers, body, snippet, truncated, finalUrl, redirects, durationMs }` or rejecting with `SafeRequestError { kind }` of FR-061. This is the superset of the shapes S41 (`safeGet`) and S43 (`safeRequest`) asked for; S02 and S08 use `safeGet`/`safeRequest` with `allowedPorts: [443]` and no redirects.
- **Idempotency** (`@app/infrastructure/idempotency`): route decorator `@Idempotent({ required?: boolean; ttlSeconds?: number })`, the module `IdempotencyModule`, the error flag `idempotencyFinal`, response header `Idempotency-Replayed: true`, problem codes above; table `IdempotencyKey` owned by `infrastructure:idempotency`; scheduled job name `platform.purge-idempotency-keys` (registered with S49). Guarantees: FR-063 to FR-069. Used by S06, S07, S10, S13, S15, S19, S20, S22, S27, S37, S42, S43.
- **Clock** (`@app/common/core/clock`): `Clock` (`now(): Date`, `nowMs(): number`), `SystemClock`, `FakeClock` (`set`, `advance`), the injection token `CLOCK`; harness overrides it with `FakeClock` (VII.2).
- **Metrics registry** (`@app/common/telemetry`): `MetricsRegistry.counter({ name, help, labels })`, `.histogram({ name, help, labels, buckets })`, `.gauge({ name, help, labels })`; rules FR-080. Capabilities register their own metric names (S29, S30, S49, S50, S52 and others); tenant and user identifiers are forbidden labels.
- **Sensitive routes** (`@app/infrastructure/platform`): route decorator `@SensitivePathParams(...names)` marking path parameters (for example `token`) that the problem `instance`, access logs and spans replace with the route template (S30, S31, S37).
- **Configuration** (`@app/common/config`): `ConfigRules.register({ owner, keys, validate })` for capability-owned rules (S02, S36, S44, S49 and others declare their own keys; none is hard-coded in the toolkit) with the helpers `requireTogether(keys)`, `httpsUrl(key, { allowLocalhost })`, `distinctSecrets(keys)`, `minSecretLength(key, n)`; typed accessors; platform settings `PlatformSettings.currency` (ISO 4217, config key `platform_currency`), `.appOrigin`, `.usercontentOrigin` (config key `usercontent_origin`), `.clientIpHeaderTrust`. Startup validation per FR-077.
- **HTTP bootstrap** (`@app/infrastructure/platform`): `configureHttpApp(app, options)`, `@SecurityPolicy('public-embed')`, `request.clientIp`, `request.rawBody: Buffer`, compression that skips `text/event-stream`, the pipeline order of AS-140, CORS exposure of `Retry-After`, `RateLimit`, `RateLimit-Policy`, `Idempotency-Replayed`, `X-Request-Id`.
- **Replica handle** (`@app/infrastructure/database`): injection token `READ_REPLICA_CONNECTION` (read-only session, verified TLS in production) for capabilities that report from a replica (S16).
- **Logging**: structured logger with redaction of the keys of AS-148 at any depth; fields `requestId`, `traceId`, `userId`, `shopId`, `route`; route templates (not parameters) for routes declared sensitive (S31).

### Requires

- **S49 (job scheduler)**: `JobRegistry.register` to schedule `platform.purge-idempotency-keys` once per schedule across replicas; used here only to run a function that purges expired idempotency records.
- **S01 (auth), S02, S42**: guards that populate `request.user.id`, `request.apiKey.{id, shopId}` and call `RequestContext.set` for `userId`, `principalType`, `roles` before interceptors run; the anonymous-route marker so the idempotency scope falls back to the client address.
- **S03 (tenancy)**: calls `RequestContext.set('shopId', …)` only after membership is verified, and never with two different values in one context.
- **S50 (rate limiter)**: throttling runs as an interceptor after guards and before the idempotency interceptor and the validation pipe (AS-140); S50 declares its own problem codes through `ProblemCatalogModule`.
- **S51 (realtime)**: registers its drain task with phase `drain` (AS-65).
- **S52, S53, S49 (stores, consumers, scheduler)**: register their probe checks (`shared`) and heartbeats and their shutdown tasks at the bands above.
- **Owning capabilities S01–S48**: declare their domain errors with `code` through `ProblemCatalogModule` and mark routes `@Idempotent`, `@LoadSheddingPriority` and sensitive path parameters as needed.
- **`infrastructure/database`** (no capability ID): the connection with pool settings, the migration step outside startup, the ownership registry entry `IdempotencyKey → infrastructure:idempotency` in `packages/backend/db/ownership.ts`.
- **`packages/contracts`**: hosts `problem.ts`.
- **Operations** (no capability ID): the probe and grace-period settings, and the edge rules of the Assumptions; the repository's image definition (AS-69).
- **Cross-domain data**: none (constitution IX.7: no R1, R2 or R3 needed).

## Pattern coverage (pattern-map rows whose Specs column names S54)

| Pattern | Where it appears |
|---|---|
| P0114 module augmentation (request context) | FR-019, AS-27 (the job registry half belongs to S49) |
| P0201 event-loop lag detection and load shedding | US6, FR-048 to FR-054, AS-73 to AS-83 |
| P0205 AsyncLocalStorage request context | US2, FR-013 to FR-019, AS-17 to AS-27 |
| P0206 keep-alive agents; server keep-alive above the load balancer idle timeout | FR-044, FR-058, AS-68, AS-96 |
| P0212 error taxonomy, async propagation, mapping to HTTP | US1, FR-001 to FR-012, FR-042, AS-01 to AS-16, AS-66 |
| P0213 graceful shutdown order, PID 1, startup ordering | US5, FR-038 to FR-047, AS-56 to AS-72 |
| P0214 request lifecycle placement | FR-076, AS-140 |
| P0215 DI scopes: no request scope on hot paths | FR-017, FR-018, AS-25, AS-26 |
| P0216 context-managed transactions across services | US3, FR-020 to FR-027, AS-28 to AS-40 |
| P0409 RFC 9457 problem details, stable codes, precise statuses | US1, FR-001 to FR-012 |
| P0503 security headers | FR-070, AS-132, AS-133 |
| P0505 strict CORS allowlist | FR-071, AS-134, AS-135 |
| P0506 safe error messages, anti-enumeration | FR-003, FR-007, AS-03, AS-09, AS-50 |
| P0616 timeouts, retries with jitter, retry budgets | US7, FR-055 to FR-060, AS-84 to AS-103 |
| P0619 load shedding and admission control | US6, AS-75 (the waiting room and flash-sale admission are S22 and S11) |
| P0704 metric types, RED/USE, cardinality caps | FR-080, AS-149, AS-150 |
| P0705 structured logs, redaction, correlation IDs | FR-079, AS-147, AS-148 |
| P0801 liveness vs readiness vs startup | US4, FR-028 to FR-037, AS-41 to AS-55 |
| P0804 configuration and secrets | FR-077, AS-141 to AS-144, AS-152 |
| P0414 idempotency keys (platform part; the rule belongs to each caller) | US9, FR-063 to FR-069, AS-116 to AS-131 |
| P0507 SSRF guard (reusable form) | US8, FR-061, FR-062, AS-104 to AS-115 |
