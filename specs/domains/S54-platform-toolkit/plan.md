# Implementation Plan: S54 — Platform toolkit

**Branch**: `S54-platform-toolkit` | **Date**: 2026-10-09 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (FR-001 to FR-080, AS-01 to AS-152), `test-plan.md`, `gaps.md` (G-01 to G-76), `questions.md` (defaults accepted as written; no line was edited by a human), constitution v3.1.0.

## Summary

Build the shared plumbing once, in the existing `libs/{common,infrastructure}` libs, by hardening the current first-draft code rather than adding new apps or domains. Twelve work packages (WP-0 to WP-11), ordered by dependency (see Phases below), cover every gaps.md item:

1. **Problem details** (one filter, code registry, `packages/contracts/problem.ts`).
2. **Request context and transactions** (join-by-default scope, `@Transactional`, `afterCommit`, network-in-transaction guard).
3. **Probes and shutdown** (shared checks never fail readiness, `/health/startup`, correct drain order, single signal owner).
4. **Load shedding, resilient client, breaker, SSRF** (`safeGet`/`safeRequest`).
5. **Idempotency facility** on a new `IdempotencyKey` table owned by `infrastructure:idempotency`.
6. **Bootstrap, config, logging, metrics, clock**.

No new deployable app (I.6), no domain code, no cross-domain data (IX.7 not used). Callers in other domains are migrated only for the `[BREAKING]` lines in `questions.md` that change a name they import (G-60, G-62, G-26, G-58, G-59).

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS 11 on Express.

**Primary Dependencies**: `nestjs-cls` (AsyncLocalStorage), Sequelize 6 + `sequelize-typescript`, `undici` (HTTP client, pinned-address connect), `pino`, OpenTelemetry, `zod`, Joi (platform config keys, kept per G-71), `class-validator` (ValidationPipe), `helmet`, `compression`. No new runtime dependency except `compression` if absent (checked in WP-10). Remove `axios` use outside the client lib (G-58).

**Storage**: PostgreSQL 16 (one new technical table `IdempotencyKey`, `infrastructure:idempotency`). Redis is **not** used by the S54 libs after the idempotency move (III.9).

**Testing**: Jest e2e (`jest-e2e.json`, `--runInBand`) against `docker-compose.test.yaml` engines with real migrations; `FakeClock`, injectable lag sampler, injectable DNS resolver, local stand-in servers, spy error tracker as the only fakes (VII.2). Child-process fixture app for shutdown/crash. Table-driven unit specs for pure logic. Run through `scripts/sdd/test-spec.sh <path-or-pattern>`; narrowest spec per task, whole capability suite once at the end.

**Target Platform**: Linux containers (ECS/ALB), `tini` init, 45 s grace period.

**Project Type**: backend libraries consumed by `apps/*` via `configureHttpApp` and module imports (monorepo `packages/backend`).

**Performance Goals**: context + logging overhead < 0.5 ms p99 (SC-008); admitted p99 < 300 ms at 2x capacity (SC-003, ops artifact).

**Constraints**: ≤ 3 sync attempts (IV.6); no network I/O in a transaction (III.3); probes never touch external stores for liveness; shutdown hard timeout 25 s under 45 s grace; pool arithmetic per III.12 (below).

**Scale/Scope**: ~12 libs touched, 12 e2e files + ~20 unit specs (test-plan.md), 87 transaction call sites audited, 3 apps without HTTP surface audited (G-34, G-46).

No `NEEDS CLARIFICATION` remains; `questions.md` defaults are accepted (research.md records the design decisions made on top of them).

### Pool arithmetic (III.12, AS-144)

Pool max per instance `P` (config `db_pool_max`, default 10) × max instances `N` (core 6 + worker 4 + projector 2 + bff 0 = 12 DB-holding instances at the production ceiling) = 120 + replica handle (`P_r` = 5 × 6 = 30) = 150, under `max_connections` 200 with 25 reserved for migrations/admin. The cross-field rule `db_pool_max × db_max_instances (+ replica) ≤ db_connection_limit − reserved` is implemented in `ConfigRules` (G-71) so a change that breaks it fails startup.

## Constitution Check

*GATE: pass before Phase 0; re-checked after Phase 1 design.*

| # | Gate | Pre | Post | Notes |
|---|---|---|---|---|
| 1 | Boundaries (I.1–I.3, Comm. Matrix; no `forwardRef`, no `Scope.REQUEST`) | PASS | PASS | S54 libs are `infrastructure`/`common`, import no `@app/domains/*` (grep, D-1..D-3 resolved). `check:no-request-scope` (G-18) added. Idempotency interceptor reaches the table through its own `infra`-style repository inside the lib. |
| 2 | Controllers/filter (II.1) | PASS | PASS | Only `HealthController` (3 routes, one service call each). All error→HTTP mapping stays in the global filter; the shedding middleware and idempotency facility throw/produce `AppError`s rendered by the shared renderer (no HTTP-shaped `try/catch` elsewhere). |
| 3 | Data access (III.2–III.12) | PASS | PASS | Transaction scope is the toolkit; `SET LOCAL` replaced by bound `set_config`; network guard enforces III.3; pool arithmetic written above; `statement_timeout` set (G-25). Idempotency claim is a unique-constraint insert (III.6), not check-then-write. `IdempotencyKey` has no principal lookup by PK: lookups are `(scope, key)`. |
| 4 | Migrations expand/contract + `lock_timeout` (III.11) | PASS | PASS | One additive `create table` migration (WP-8) with `SET lock_timeout`; purge function is a separate additive migration step. No rename/drop. Migrations stay out of app startup (AS-71 static check). |
| 5 | Messaging (IV.4–IV.6) | PASS | PASS | S54 publishes/consumes nothing. Every outbound call has timeout/deadline, retry at one layer, ≤ 3 attempts. `outbox.append` consumer contract (`assertActiveTransaction`) provided for S53. |
| 6 | Contracts (V.x) | PASS | PASS | `packages/contracts/problem.ts` (zod); problem+json with `type, title, status, detail, instance, code, requestId`; `Idempotency-Key` semantics V.6 implemented (replay / 409 / 422 / TTL). |
| 7 | Web (VI.x) | N/A | N/A | No UI. |
| 8 | Tests (VII.2/3/4/9) | PASS | PASS | Test-plan.md maps 152 scenarios to 12 e2e + unit files; forced fallbacks (breaker, shed, store outage, degraded readiness) have tests; consumers N/A (no consumer). Green run recorded in WP-11. |
| 9 | Operational (VIII.1–VIII.7) | PASS | PASS | Structured logs with `requestId`, redaction at any depth; `instrument.ts` first import audit (WP-10); liveness in-process only; readiness not failed by shared DB; shutdown order per VIII.4; config schema-validated at startup. |
| 10 | DB isolation (IX.3–IX.7) | PASS | PASS | Registry row `IdempotencyKey → infrastructure:idempotency` (IX.3 allowlist) added in the same PR; `check:table-ownership` run first and last, `infrastructure` lines must be 0 other than this table. No cross-domain query/FK; reached only via the lib's exported facility (IX.6). |
| 11 | Monorepo (X.1–X.8) | PASS | PASS | Placement per X.7: breaker/clock/errors/filter/config/logging/telemetry/load-shedding in `common`; context/health/lifecycle/platform/http-client/net/idempotency in `infrastructure`. `common` imports no `infrastructure` (G-74: `CLOCK` token lives in `common/core`; the Sequelize-aware pieces stay in `infrastructure/context`). Public `index.ts` entry points for each lib (G-60). `check:boundaries` required green. |

**Complexity Tracking**: none required. Two points reviewed and found not to be violations: (a) `common/exceptions-filter` renders `RetryAfter` and Express headers (it takes `Response` as a type-only dependency, as today); (b) the `ConfigRules`/`MetricsRegistry` engines are generic and own no capability names.

## Project Structure

### Documentation (this feature)

```text
specs/domains/S54-platform-toolkit/
├── plan.md              # this file
├── research.md          # Phase 0: design decisions
├── data-model.md        # Phase 1: entities, IdempotencyKey table, state machines
├── quickstart.md        # Phase 1: validation scenarios and commands
├── contracts/
│   ├── problem-details.md      # problem document + code registry + status table
│   ├── platform-http.md        # probes, headers, pipeline order, idempotency HTTP semantics
│   └── toolkit-api.md          # TypeScript public entry points (Provides)
├── spec.md  test-plan.md  gaps.md  questions.md
└── tasks.md             # NOT created here (/speckit-tasks)
```

### Source Code (all under `packages/backend/`)

```text
libs/common/
├── core/              clock.ts (+CLOCK token, global ClockModule), backoff.ts
├── errors/            error.types.ts (code/extensions/retryAfterSeconds/idempotencyFinal/headers),
│                      problem-catalog.module.ts (ProblemCatalogModule.forFeature), platform-codes.ts,
│                      error-utils/error-utils.service.ts (db/framework mapping)
├── exceptions-filter/ exceptions-filter.ts, problem-document.ts (pure builder), sensitive-path-params.decorator.ts
├── request-context/   types.ts (AppClsStore: + clientIp, traceparent, deadlineAt; open for declaration merging)
├── resilience/        circuit-breaker.ts, index.ts            (NEW lib)
├── load-shedding/     shedding-policy.ts (pure), load-shedding.middleware.ts, priority.decorator.ts, event-loop-monitor.service.ts
├── config/            config-rules.ts (ConfigRules + helpers), api-config.service.ts (platform keys only)
├── logging/           logging.module.ts, redaction.ts (pure), exempt-paths.ts (single list)
└── telemetry/         telemetry.ts (flush becomes a registry task), metrics-registry.ts
libs/infrastructure/
├── context/           request-context.{module,service}.ts, request-id.ts (pure), transaction-runner.service.ts,
│                      transaction-options.ts (pure), transactional.decorator.ts, index.ts
├── health/            readiness.service.ts, liveness.service.ts, startup.service.ts, health.controller.ts, health.module.ts, management-listener.ts, index.ts
├── lifecycle/         graceful-shutdown.ts, shutdown-registry.service.ts, shutdown-config.ts (pure rule), crash-handlers.ts, index.ts
├── platform/          bootstrap-http.ts (configureHttpApp, pipeline order), client-ip.ts (pure), security-policy.decorator.ts, raw-body.ts, index.ts
├── http-client/       resilient-http-client.ts, retry-budget.ts, bulkhead.ts, retry-options.ts, index.ts
├── net/               ssrf-guard.ts, pinned-request.ts (safeGet/safeRequest), index.ts
├── idempotency/       idempotent.decorator.ts, idempotency.interceptor.ts, idempotency.module.ts, idempotency.repository.ts,
│                      idempotency-key.model.ts, fingerprint.ts (pure), purge.service.ts, index.ts
└── database/          connection settings (statement_timeout, idle_in_transaction, application_name, acquire), READ_REPLICA_CONNECTION
migrations/            20261009xxxxxx-idempotency-key.js (+ purge function), expand-only, lock_timeout
db/ownership.ts        IdempotencyKey: 'infrastructure:idempotency'
scripts/               check-no-request-scope.ts, check-image-definition.ts, check-no-migrate-on-boot.ts (+ package.json scripts)
packages/contracts/    problem.ts (problemDetailsSchema, ProblemDetails)
```

**Structure Decision**: extend the existing libs in place; add exactly one new lib (`common/resilience`) and one new table. Each lib gets an `index.ts` entry (X.4) and callers' deep imports are rewritten (G-60).

## Work packages (phases of implementation; ordering from gaps.md "Order of work")

Every gaps.md item appears in exactly one WP. Each WP is test-first: write the e2e/unit rows from test-plan.md, then the code, run the narrowest spec through `scripts/sdd/test-spec.sh`.

| WP | Goal | Gaps covered | Test files (test-plan short names) |
|---|---|---|---|
| **WP-0** Static gates and baseline | Run `check:table-ownership` (+ `--strict`), `check:boundaries`, `tsc --noEmit`; paste the `infrastructure` lines (expect 0) into gaps.md; add `check:*` scripts skeleton; add `CLOCK`-less lint placeholders | ownership row of debt register; G-18 (script), G-45 (scripts), G-74 (lint rule) | static |
| **WP-1** Problem details | `AppError` fields + required `code`; catalogue module + duplicate check; renderer; filter rewrite; error-utils mapping (db 23505→409, 57014, 55P03, 40001/40P01, pool timeout); `problem.ts` contract; sensitive-path decorator; logging split warn/error with `requestId`; tracker seam; shedding body via renderer | G-01 – G-13 | ERR, U-DOC |
| **WP-2** Context | `AppClsStore` fields; `shopId` immutability; `snapshot()`, `memo()`; `request-id.ts`; traceparent stored; `check:no-request-scope`; typed declaration-merging test | G-14 – G-19 | CTX, U-RID |
| **WP-3** Transactions and DB settings | `propagation`, bounded `set_config` timeouts, `@Transactional`, `afterCommit`, `getActiveTransaction`/`assert…`, serializable retry ≤ 3 + `503`, network guard hook, concurrency isolation, connection settings + acquire timeout + pool arithmetic + replica handle, callers audit | G-20 – G-26 | TX, DB, U-TXO |
| **WP-4** Probes and startup | `scope`/`failureThreshold`/abort/500 ms; 2 s cache + single-flight; `StartupService` + `/health/startup`; liveness thresholds + heartbeats; drop `SkipThrottle`; one exempt list; management listener; `no-store`; gauges | G-27 – G-36 | HEALTH |
| **WP-5** Shutdown | New sequence in `graceful-shutdown.ts`; registry (concurrent equal order, phase `drain`, reject late register, exit 1 on failure); `process.on` guard; telemetry as order-95 task; crash handlers; startup ordering/deadline; image + no-migrate checks; worker apps audit | G-37 – G-47 | SHUT, U-SDC |
| **WP-6** Load shedding | Pure policy + hysteresis; priority decorator; in-flight counter; randomised `Retry-After`; ordering before body parsers; monitor seam, fail-open; metric + sampled log | G-48 – G-51 | SHED, U-SHEDP |
| **WP-7** Resilient HTTP, breaker, SSRF | `maxAttempts`, remove 500, `Retry-After` cap, per-host budget with clock, response cap, typed errors, URL logging, bulkhead, breaker lib, deadline propagation, 3 s connect timeout, remove axios `RequestService`, migrate Stripe/channel-sender/webhook-deliverer, `safeGet`/`safeRequest`, escape-hatch refusal, caller migration | G-53 – G-59, G-61, G-76 | HTTP, SSRF, U-CB, U-RETB, U-RETO, U-CORE, U-SSRF (extended to AS-105/106), U-URL |
| **WP-8** Idempotency | Model + migration + ownership row + repository (atomic claim, lock expiry, fingerprint canonicalisation) + `@Idempotent` + module + replay/in-flight/reuse codes + fail-closed + purge job; migrate S42 controller and `public-api.module` | G-52, G-62 – G-64 | IDEM (fingerprint canonicalisation is proven through e2e; no unit row in test-plan.md) |
| **WP-9** Public entry points | `index.ts` per lib; rewrite deep imports; boundary check | G-60 | check:boundaries |
| **WP-10** Bootstrap, config, logging, metrics, clock | helmet/CORS/validation pipe/trusted proxy/body limit/raw body/compression/pipeline order; `ConfigRules` + cross-field rules; redaction + access line; `MetricsRegistry`; `CLOCK` token + lint rule; update `[BREAKING]` callers' tests | G-65 – G-75 | BOOT, OBS, U-IP, U-CFG, U-RED, U-MET |
| **WP-11** Closure | Whole capability suite once, `tsc`, ESLint, `check:boundaries`, `check:table-ownership --strict`, record the green run in `quickstart.md` result section; load-proof checklist for SC-002/3/4/8 recorded as ops artifact | all (VII.9) | all |

### Cross-WP rules

- Test-fix budget: the same test failing after 5 fix attempts stops the loop; the blocker, attempts and hypothesis go to `questions.md`.
- Deliberately failing existing tests (extra fields now `400`, new problem members, `Idempotency-Replayed`) are updated in the same WP that causes them (questions.md `[BREAKING]` lines).
- `[CONTRACT]` items are satisfied by the exact names in `contracts/toolkit-api.md`; sibling specs are not edited here except to note S50's header rename in the final report.
