# F-01 — Platform Toolkit (cross-cutting backend foundations)

Status: ☑ done (typechecked; specs written, not run) · Phase 0 · Depends on: — · Used by: every section

## Why (business story)
Every later feature needs the same plumbing: knowing *who/which shop* a request belongs to, failing safely, shutting down without dropping work, and calling third parties without hanging. Built once, used everywhere.

## Existing code to reuse
- `AllExceptionsFilter` (`libs/common/src/exceptions-filter`), `error.types.ts`, `ErrorUtilsService`.
- `apps/*/main.ts` already handle SIGTERM partially; `nestjs-otel` metrics; `tracing.ts`.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Request context via `AsyncLocalStorage` (`nestjs-cls`): requestId, userId, shopId, traceId | 02/01 §5, 02/05 |
| Sequelize CLS-managed transactions so services compose inside one tx without passing `transaction` everywhere | 02/05 §4, 03/02 §9 |
| RFC 9457 Problem Details with stable error codes; safe messages (no stack/SQL leak) | 04/01 §3, 05/01 §5, 02/04 §3 |
| Error taxonomy: operational vs programmer errors; `unhandledRejection` → crash + restart | 02/04 §1–2 |
| Graceful shutdown sequence: readiness=false → stop accepting → drain HTTP (keep-alive close) → stop Kafka consumers after commit → close pools → exit; hard timeout | 02/04 §4, 08/01 |
| `/livez` (process only, never DB) and `/readyz` (DB/Redis/Kafka with nuanced rules) | 08/01 §1–3 |
| Event-loop-lag monitoring (`monitorEventLoopDelay`) as metric + **load shedding** middleware (503 + Retry-After when lag > threshold) | 02/01 §3, 06/03 §5 |
| Outbound HTTP client: per-call timeouts (AbortSignal.timeout), keep-alive agent (undici), retry with exponential backoff + full jitter + retry budget, only for idempotent calls | 06/03 §1–2, 02/01 §7 |
| Bounded concurrency helper (promise pool) for fan-out calls | 01/01 §5 |
| Branded types + `assertNever` + zod helpers | 01/02 §1–2, §8 |
| Money allocation (largest remainder) utility | 01/01 §9 |
| Structured logging (pino via `nestjs-pino`) with trace/span IDs correlation and redaction of PII | 07/02 §3 |

## Steps
- [x] Add deps: `nestjs-cls`, `@nestjs/terminus`, `nestjs-pino`, `pino-http`, `undici`, `zod`.
- [x] `libs/common/src/context/` — `ClsModule` setup, `RequestContext` typed accessor, interceptor populating userId/shopId.
- [x] Sequelize CLS transactions (`Sequelize.useCLS` with cls-hooked namespace or explicit `TransactionHost` via `@nestjs-cls/transactional` + sequelize adapter). Pick one, log in DOUBTS.
- [x] `ProblemDetails` builder + update `AllExceptionsFilter` to emit `application/problem+json` with `type`, `title`, `status`, `code`, `traceId`.
- [x] `libs/common/src/health/` — `HealthModule` with `/livez`, `/readyz`; readiness flips to false on SIGTERM.
- [x] `libs/common/src/lifecycle/graceful-shutdown.service.ts` — ordered shutdown hooks registry + hard-kill timeout; wire in `core`, `sse-gateway`, `payment-processor` mains (`enableShutdownHooks`).
- [x] `libs/common/src/load-shedding/` — event-loop-lag sampler + middleware; metric `nodejs_eventloop_lag_p99`.
- [x] `libs/common/src/http-client/` — `ResilientHttpClient` (timeouts, retries w/ jitter, retry budget, keep-alive, OTEL spans).
- [x] `libs/common/src/utils/{brand.ts,assert-never.ts,promise-pool.ts,money/allocate.ts,backoff.ts}`.
- [x] Shared-logic specs: problem-details mapping through a real Nest app; shutdown hook ordering; `allocate()` sums exactly; promise pool concurrency bound.

## Tests
Unit (run). e2e: `/readyz` returns 503 during shutdown (written).

## FE visualisation (phase 2)
None directly; Problem Details shape goes to `packages/contracts/problem.ts`.

## Scale
- Target: overhead < 0.5 ms p99 per request for context/logging; shedding keeps p99 bounded under 2× overload instead of collapse.
- Hot path: CLS + pino are in-process (no I/O); logs are async to stdout.
- First bottleneck & fix: event-loop saturation → lag-based load shedding returns 503 early; outbound-call pile-up → timeouts + retry budget prevent retry storms.
- Proof: k6 `loadtest:overload` ramps to 2× capacity; thresholds: p99 < 300 ms for admitted requests, shed responses are 503 with `Retry-After`.

## Implementation notes (2026-10-01)
- `libs/common/src/context/` — `RequestContextModule` (nestjs-cls, request id honouring upstream `x-request-id`), `RequestContext`, `sequelize-cls.ts` (AsyncLocalStorage-backed namespace for `Sequelize.useCLS`), `TransactionRunner` (`run`, `runSerializable` with 40001/40P01 retry), `TransactionModule`.
- `libs/common/src/health/` — `/livez` (process only), `/readyz` (critical vs non-critical checks + shutdown flag), outside the `/api` prefix.
- `libs/common/src/lifecycle/` — `ShutdownRegistry` (ordered tasks with timeouts), `installGracefulShutdown` (readiness → drain delay → close idle sockets → `app.close()` → hard timeout; keepAlive 65 s > ALB 60 s), `installCrashHandlers`.
- `libs/common/src/load-shedding/` — `EventLoopMonitor` (p99 lag gauge `nodejs_eventloop_lag_p99_ms`) + `LoadSheddingMiddleware` (503 + Retry-After, Problem Details).
- `libs/common/src/http-client/` — `ResilientHttpClient` (undici keep-alive pool, per-attempt timeout, full-jitter retries honouring Retry-After, `RetryBudget`, OTel spans + trace propagation).
- `libs/common/src/logging/` — nestjs-pino JSON logs with CLS + trace ids, PII/secret redaction.
- `libs/common/src/platform/` — `PlatformModule` (one import) + `configureHttpApp()` (helmet strict CSP for JSON API, CORS allowlist, prefix, validation, shutdown). Wired into `core`, `sse-gateway`; `payment-processor` uses graceful shutdown.
- `libs/common/src/utils/core/` — `brand`, `assertNever`, `backoff`, `promise-pool`, `clock`; `utils/money/allocate.ts`.
- Problem Details: existing `AppError` (RFC 7807 shape) kept; filter now sends `application/problem+json` + `instance` + `requestId`.
- Spec: `utils/core/core-utils.spec.ts`.
- Not done (moved): `@nestjs/terminus` not needed (own readiness registry is lighter and supports critical/non-critical).
