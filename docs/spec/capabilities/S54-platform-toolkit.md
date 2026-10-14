---
id: S54
title: Platform toolkit: problem+json errors, request context and transactions, health probes, graceful shutdown, load shedding, resilient HTTP
kind: capability
status: draft
generated_at: e95ce81
depends_on: []
concepts: [problem-json-errors, request-context, transaction-runner, idempotency-key, rate-limit-policy]
models: []
scope:
  - packages/backend/apps/lambdas/src/handlers/**
  - packages/backend/libs/common/core/**
  - packages/backend/libs/common/errors/**
  - packages/backend/libs/common/exceptions-filter/**
  - packages/backend/libs/common/load-shedding/**
  - packages/backend/libs/common/logging/**
  - packages/backend/libs/common/request-context/**
  - packages/backend/libs/common/resilience/**
  - packages/backend/libs/common/routing/**
  - packages/backend/libs/common/telemetry/**
  - packages/backend/libs/domains/assistant/**
  - packages/backend/libs/domains/auctions/**
  - packages/backend/libs/domains/catalog/**
  - packages/backend/libs/domains/catalog-sync/**
  - packages/backend/libs/domains/chat/**
  - packages/backend/libs/domains/content/**
  - packages/backend/libs/domains/developer-platform/**
  - packages/backend/libs/domains/discovery/**
  - packages/backend/libs/domains/experimentation/**
  - packages/backend/libs/domains/fulfilment/**
  - packages/backend/libs/domains/identity/**
  - packages/backend/libs/domains/marketing/**
  - packages/backend/libs/domains/media/**
  - packages/backend/libs/domains/notifications/**
  - packages/backend/libs/domains/orders/**
  - packages/backend/libs/domains/payments/**
  - packages/backend/libs/domains/seller-insights/**
  - packages/backend/libs/domains/seller-onboarding/**
  - packages/backend/libs/domains/statements/**
  - packages/backend/libs/domains/tenancy/**
  - packages/backend/libs/infrastructure/aws/**
  - packages/backend/libs/infrastructure/cache/**
  - packages/backend/libs/infrastructure/cassandra/**
  - packages/backend/libs/infrastructure/clickhouse/**
  - packages/backend/libs/infrastructure/context/**
  - packages/backend/libs/infrastructure/database/**
  - packages/backend/libs/infrastructure/dynamo/**
  - packages/backend/libs/infrastructure/elasticsearch/**
  - packages/backend/libs/infrastructure/firebase/**
  - packages/backend/libs/infrastructure/health/**
  - packages/backend/libs/infrastructure/http-client/**
  - packages/backend/libs/infrastructure/idempotency/**
  - packages/backend/libs/infrastructure/jobs/**
  - packages/backend/libs/infrastructure/kafka/**
  - packages/backend/libs/infrastructure/lifecycle/**
  - packages/backend/libs/infrastructure/net/**
  - packages/backend/libs/infrastructure/outbox/**
  - packages/backend/libs/infrastructure/platform/**
  - packages/backend/libs/infrastructure/projections/**
  - packages/backend/libs/infrastructure/redis/**
  - packages/backend/libs/infrastructure/sqs/**
  - packages/backend/libs/infrastructure/storage/**
  - packages/backend/libs/infrastructure/stripe/**
---
# S54 - Platform toolkit: problem+json errors, request context and transactions, health probes, graceful shutdown, load shedding, resilient HTTP
## Purpose
Every backend app needs the same operating base: one error format, a per-request context, transactions, health probes, an ordered shutdown, overload protection, safe outbound HTTP and idempotent writes. This page describes that shared toolkit. Product teams build on it and do not re-implement these concerns. Operators rely on it to deploy, drain and restart apps without dropping requests.

## Entry points
- `GET|HEAD /health/live`: answers whether the process can make progress. It never touches a store. [code: packages/backend/libs/infrastructure/health/health.controller.ts#HealthController]
- `GET|HEAD /health/ready`: answers whether the load balancer may send traffic. [code: packages/backend/libs/infrastructure/health/health.controller.ts#HealthController]
- `GET|HEAD /health/startup`: answers whether warm-up work has finished. [code: packages/backend/libs/infrastructure/health/health.controller.ts#HealthController]
- Management listener: serves the three probes on a configured port for apps without an HTTP surface. [code: packages/backend/libs/infrastructure/health/management-listener.ts#startManagementListener]
- Global exception filter: renders every error as {{concept:problem-json-errors}}. [code: packages/backend/libs/common/exceptions-filter/exceptions-filter.ts#AllExceptionsFilter]
- Request context: one isolated context per HTTP request, consumer message and job run ({{concept:request-context}}). [code: packages/backend/libs/infrastructure/context/request-context.service.ts#RequestContext]
- Transaction scope: `run` and the `@Transactional` decorator ({{concept:transaction-runner}}). [code: packages/backend/libs/infrastructure/context/transaction-runner.service.ts#TransactionRunner]
- SIGTERM and SIGINT: start the ordered shutdown sequence. [code: packages/backend/libs/infrastructure/lifecycle/graceful-shutdown.ts#createGracefulShutdown]
- `unhandledRejection` and `uncaughtException`: crash handlers. [code: packages/backend/libs/infrastructure/lifecycle/crash-handlers.ts#installCrashHandlers]
- Load-shedding gate: runs first on every HTTP request. [code: packages/backend/libs/common/load-shedding/load-shedding.middleware.ts#LoadSheddingGate]
- Resilient HTTP client, `safeGet` and `safeRequest`: outbound calls. [code: packages/backend/libs/infrastructure/http-client/resilient-http-client.ts#ResilientHttpClient] [code: packages/backend/libs/infrastructure/net/pinned-request.ts#safeRequest]
- `@Idempotent` route declaration and the purge job ({{concept:idempotency-key}}). [code: packages/backend/libs/infrastructure/idempotency/idempotent.decorator.ts#Idempotent]
- `bootstrapApp` and `configureHttpApp`: startup and HTTP pipeline for every app. [code: packages/backend/libs/infrastructure/lifecycle/startup.ts#bootstrapApp]

## Rules
- **S54.R-01** Every error response MUST be [`application/problem+json` ↗](../sw-external-terms.md#problem-json) with exactly the members [`type`, `title`, `status`, `detail`, `instance`, `code`, `requestId`](../terms/exact-body-members.md), plus [`traceId`](../terms/trace-id.md) when a trace is active. [proof: S54 AS-01, S54 AS-15] [code: packages/backend/libs/common/exceptions-filter/problem-document.ts#buildProblemDocument]
- **S54.R-02** For status 500 and above, [`detail`](../terms/problem-detail.md) MUST be the [fixed catalogue text](../terms/error-catalogue.md); thrown messages, wrapped causes, SQL and stack traces MUST NOT reach the body in any environment. [proof: S54 AS-02, S54 AS-03, S54 AS-04]
- **S54.R-03** Validation failures MUST return [`400 validation_failed`](../terms/validation-failed-error.md) and list every failing field at once, without echoing input values. [proof: S54 AS-05]
- **S54.R-04** Malformed JSON returns [`400 malformed_body`](../terms/malformed-body.md), an oversized body [`413 payload_too_large`](../terms/payload-too-large.md), a wrong media type [`415 unsupported_media_type`](../terms/unsupported-media-type.md), an unknown route [`404 not_found`](../terms/not-found-error.md), and a wrong method [`405 method_not_allowed`](../terms/method-not-allowed.md) with an [`Allow` header ↗](../sw-external-terms.md#allow-header). [proof: S54 AS-06, S54 AS-07]
- **S54.R-05** A raw database [unique violation ↗](../sw-external-terms.md#unique-violation) MUST render as [`409 conflict`](../terms/conflict-error.md) with generic text and no column, constraint or value. [proof: S54 AS-09]
- **S54.R-06** [Extension members](../terms/extension-members.md) MUST NOT override a [reserved member](../terms/reserved-members.md); [`retryAfterSeconds`](../terms/retry-after-seconds.md) MUST produce a [`Retry-After` header ↗](../sw-external-terms.md#retry-after). [proof: S54 AS-10]
- **S54.R-07** Two registrations of one [`code`](../terms/error-code.md) with different definitions MUST [fail startup](../terms/startup-validation.md) and name both [owners](../terms/error-code-registration.md). [proof: S54 AS-12]
- **S54.R-08** Routes with a [sensitive path parameter](../terms/sensitive-path-parameter.md) MUST show the route template in [`instance`](../terms/problem-instance.md) and in logs. [proof: S54 AS-14]
- **S54.R-09** [The filter](../terms/problem-exception-filter.md) MUST NOT write after headers are sent and MUST NOT throw; if rendering fails it MUST emit a minimal [`500 internal_error`](../terms/internal-error.md). [proof: S54 AS-13, S54 AS-16]
- **S54.R-10** An inbound [`X-Request-Id`](../terms/request-id.md) MUST be kept only when it has 8 to 128 characters of letters, digits, `.`, `_`, `-` and appears once; otherwise a [UUIDv7 ↗](../sw-external-terms.md#uuidv7) replaces it. [proof: S54 AS-17, S54 AS-18] [code: packages/backend/libs/infrastructure/context/request-id.ts#resolveRequestId]
- **S54.R-11** Concurrent requests MUST NOT see each other's [context values](../terms/request-context.md). [proof: S54 AS-19, S54 AS-22]
- **S54.R-12** Once [`shopId`](../terms/shop-id-param.md) is set in a [context](../terms/request-context.md), setting a different value MUST fail as a [programmer error](../terms/programmer-error.md). [proof: S54 AS-21]
- **S54.R-13** [Reading the context outside a run](../terms/request-context.md) MUST return `undefined` and MUST NOT throw. [proof: S54 AS-23]
- **S54.R-14** A [transaction scope](../terms/transaction-scope.md) MUST commit on success and [roll back ↗](../sw-external-terms.md#database-transaction) on any error, rethrowing it unchanged; [`afterCommit` callbacks](../terms/after-commit-callback.md) MUST run once, after commit, in registration order, and never on rollback. [proof: S54 AS-28, S54 AS-29, S54 AS-30]
- **S54.R-15** A [serializable scope](../terms/serializable-scope.md) MUST retry error codes [`40001` ↗](../sw-external-terms.md#postgres-serialization-errors) and `40P01` up to 3 attempts in total and MUST NOT retry any other error; exhaustion returns `[503 transaction_conflict](../terms/transaction-conflict.md)`. [proof: S54 AS-35, S54 AS-36]
- **S54.R-16** [Statement and lock timeouts](../terms/transaction-timeouts.md) MUST be integers from 1 to 600 000 ms and MUST NOT be [interpolated into SQL ↗](../sw-external-terms.md#sql-injection). [proof: S54 AS-37, S54 AS-38]
- **S54.R-17** The outbound HTTP client, [`safeGet` and `safeRequest`](../terms/safe-http-client.md) MUST refuse to send while [a transaction is active](../terms/active-transaction.md). [proof: S54 AS-40]
- **S54.R-18** [`/health/live`](../terms/health-probes.md) MUST NOT touch any external store and MUST fail only on [event-loop p99](../terms/event-loop-lag.md) above 10 000 ms or a [silent heartbeat](../terms/liveness-heartbeat.md). [proof: S54 AS-41, S54 AS-52, S54 AS-53]
- **S54.R-19** [Readiness](../terms/readiness.md) MUST return 503 while starting, while shutting down, or when a [critical pod-local check](../terms/health-check-criticality.md) fails; failing shared checks are reported but MUST NOT fail readiness. [proof: S54 AS-42, S54 AS-43, S54 AS-45, S54 AS-47]
- **S54.R-20** [Probe bodies](../terms/health-probes.md) MUST list check names and `up` or `down` only; error text goes to logs and the gauge [`health_check_up`](../terms/health-check-up.md). [proof: S54 AS-50, S54 AS-55]

## Behaviors
- **S54.B-01** Given a route throws a [domain error](../terms/error-code.md) `order_not_found` with status 404, when a client calls it, then it receives a 404 [problem+json ↗](../sw-external-terms.md#problem-json) with [`code: order_not_found`](../terms/order-not-found.md). [proof: S54 AS-01]
- **S54.B-02** Given a route throws a plain `TypeError`, when it is called, then the client receives [`500 internal_error`](../terms/internal-error.md) with [`detail: "An unexpected error occurred."`](../terms/problem-detail.md) and no stack text. [proof: S54 AS-02]
- **S54.B-03** Given a 404 and a 500 error, when both occur, then the 404 logs at `warn` without stack and the 500 at `error` with stack, and both lines carry [`requestId`](../terms/request-id.md). [proof: S54 AS-11]
- **S54.B-04** Given a request without [`X-Request-Id`](../terms/request-id.md), when it is served, then a [UUIDv7 ↗](../sw-external-terms.md#uuidv7) appears in the response header, the logs, [the context](../terms/request-context.md) and any error body. [proof: S54 AS-17]
- **S54.B-05** Given two services insert rows without receiving a [transaction object](../terms/active-transaction.md), when a [transactional method](../terms/transactional-decorator.md) calls both and the second throws, then neither row exists. [proof: S54 AS-28, S54 AS-29]
- **S54.B-06** Given two [serializable scopes](../terms/serializable-scope.md) would each remove an owner, when they run concurrently, then exactly one removal persists. [proof: S54 AS-35]
- **S54.B-07** Given the database and cache are unreachable, when [`/health/ready`](../terms/health-probes.md) is called, then it answers 200 with both checks `down`. [proof: S54 AS-42]
- **S54.B-08** Given a [readiness check](../terms/health-probes.md) never settles, when `/health/ready` is called, then the check shows `down` after 500 ms and the response arrives in under 1 s. [proof: S54 AS-48]
- **S54.B-09** Given 100 concurrent readiness calls, when the [check cache](../terms/health-probes.md) is valid, then the check runs once. [proof: S54 AS-49]
- **S54.B-10** Given [SIGTERM ↗](../sw-external-terms.md#termination-signal) arrives, when the sequence runs, then readiness turns false, the [drain delay](../terms/graceful-shutdown-drain.md) passes, the server stops accepting, in-flight requests finish, then [tasks run in ascending order](../terms/shutdown-tasks.md). [proof: S54 AS-56, S54 AS-57]
- **S54.B-11** Given a handler never finishes, when the [request-drain timeout](../terms/request-drain-timeout.md) of 500 ms elapses, then its socket is destroyed, `shutdown_request_drain_timeout` is logged and [the sequence continues](../terms/shutdown-sequence.md). [proof: S54 AS-59]
- **S54.B-12** Given a [shutdown task](../terms/shutdown-task.md) fails or times out, when shutdown ends, then later tasks still run and the exit code is 1. [proof: S54 AS-61]
- **S54.B-13** Given the [hard timeout](../terms/hard-shutdown-timeout.md) passes, when the sequence still runs, then the process logs `forced shutdown` and exits 1. [proof: S54 AS-62]
- **S54.B-14** Given an [unhandled rejection ↗](../sw-external-terms.md#unhandled-rejection) or uncaught exception, when it occurs, then the cause is written to stderr and the log and the process exits 1. [proof: S54 AS-66]
- **S54.B-15** Given a worker with no HTTP server, when [SIGTERM ↗](../sw-external-terms.md#termination-signal) arrives, then it stops the consumer, [flushes](../terms/shutdown-flush.md), [closes pools ↗](../sw-external-terms.md#connection-pool) and exits 0 without HTTP steps. [proof: S54 AS-72]
- **S54.B-16** Given [invalid configuration](../terms/startup-validation.md) with three bad keys, when the app starts, then it exits 1 without listening and lists key names, not values. [proof: S54 AS-70, S54 AS-141]
- **S54.B-17** Given a request with a new [`Idempotency-Key`](../terms/idempotency-key.md) repeated, when [the route requires a key](../terms/idempotent-decorator.md), then [the stored response is replayed](../terms/idempotency-stored-answer.md) with [`Idempotency-Replayed: true`](../terms/idempotency-replayed.md) and the handler runs once. [proof: S54 AS-116, S54 AS-130]
- **S54.B-18** Given the same key with a different body, when it arrives, then it returns [`422 idempotency_key_reuse`](../terms/idempotency-key-reuse.md). [proof: S54 AS-119, S54 AS-120]
- **S54.B-19** Given the [idempotency store](../terms/idempotency-store.md) is unreachable, when a required-key request arrives, then it returns [`503 idempotency_unavailable`](../terms/idempotency-unavailable.md) and the handler does not run. [proof: S54 AS-127]
- **S54.B-20** Given a hostname resolves to a [private address ↗](../sw-external-terms.md#ssrf), when [`safeGet`](../terms/safe-http-client.md) runs, then it fails with [`blocked_address`](../terms/blocked-address.md). [proof: S54 AS-105, S54 AS-106]

## Lifecycles
Readiness moves from not-ready to ready when startup ends and to not-ready when shutdown begins. Startup never regresses. The startup service and shutdown sequence own these moves. Circuit breaker states are CLOSED, OPEN and HALF_OPEN; the breaker moves them from call outcomes. See no model file: the facts list none.

## Owns
- Table `IdempotencyKey`, owned by `infrastructure:idempotency`. [code: packages/backend/libs/infrastructure/idempotency/idempotency-key.model.ts#IdempotencyKeyModel]
- Metrics: `platform_ready`, `health_check_up`, `nodejs_eventloop_lag_p99_ms`, `http_requests_shed_total`, `network_call_in_transaction_total`, `http_client_retry_budget_exhausted_total`.
- Configuration: problem base URL, shutdown timings, server timeouts, pool settings, trusted proxies, CORS allowlist, management port, replica URL, shedding threshold and in-flight cap.

## Decisions
- Shared outages do not fail readiness, so one store outage does not remove every pod.
- Liveness uses only in-process state, so a database outage does not cause a restart storm.
- Detail for 500-level problems is fixed catalogue text, so internals never leak.
- Context travels through the context mechanism, not request-scoped providers.
- Network calls inside a transaction are refused, so locks are not held across the network.
- The idempotency store fails closed, so a duplicate side effect is never possible.
- Timings are validated at startup (`drain + request drain < hard timeout`), so the hard timeout never cuts the normal sequence.

## Known gaps
- Load shedding (AS-73 to AS-83, P2) has tests, but the shedding rules R-xx are not stated here beyond the tests. Tiers, hysteresis and the in-flight cap are untested in this page's rules.
- Resilient HTTP client (AS-84 to AS-103, P2) is covered by tests but not listed as rules here.
- No test carries a scenario id for AS-26, AS-27, AS-69, AS-71, AS-108, AS-109, AS-110, AS-142, AS-143, AS-144, AS-151 (static or compile-time checks may exist; unverified here).
- AS-20, AS-24 and AS-25 are covered; AS-26 (no request-scoped provider) has a script `check-no-request-scope.ts` but no tagged test.
- AS-64 (equal-order tasks run concurrently) and AS-58 are tagged, but are not stated as separate rules.
- AS-117 to AS-129 idempotency details (header replay, TTL 24 h, lock expiry 60 s, 256 KiB cap) are tested but only summarised in B-17 to B-19.
- AS-131 (ownership registry) has no tagged test.
- Security headers, CORS, client IP and compression (AS-132 to AS-139) are tested but not stated as rules.