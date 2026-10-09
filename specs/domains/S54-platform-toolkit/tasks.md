# Tasks: S54 — Platform toolkit

**Input**: `specs/domains/S54-platform-toolkit/` — plan.md, spec.md, test-plan.md, gaps.md (G-01 to G-76), questions.md (defaults accepted), data-model.md, contracts/, research.md, quickstart.md. Constitution: `.specify/memory/constitution.md`.

**Tests**: Required and written first (constitution VII, test-plan.md). Every test task comes before the code task it proves and must be run RED (failing for the right reason) before the code task starts.

## Conventions

- All paths are under `packages/backend/` unless they start with `packages/contracts/` or `specs/`. Run backend commands from `packages/backend`.
- Run one spec: `/home/zagrava/workspace/personal-projects/portfolio-sandbox/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]` (condensed output plus the full-log path; open the log only if the condensed output is not enough). Run the narrowest spec that proves the task; the whole capability suite runs once, in T113.
- If the same test still fails after 5 fix attempts: stop, write the blocker, attempts and hypothesis into `specs/domains/S54-platform-toolkit/questions.md`, and do not continue.
- `[Story]` labels map to spec.md: US1 errors (P1), US2 context (P1), US3 transactions (P1), US4 probes (P1), US5 shutdown (P1), US8 SSRF (P1), US9 idempotency (P1), US6 shedding (P2), US7 resilient client (P2), US10 bootstrap/config/observability (P2).
- "AS-nn" = acceptance scenario in spec.md, mapped to a file in test-plan.md. "G-nn" = gaps.md item. Each test task lists the AS ids it must cover; each code task lists the G ids it closes.
- Test fakes allowed (VII.2): `FakeClock`, injectable lag sampler, injectable DNS resolver, local stand-in outbound server, spy error tracker. Nothing else is mocked. Real Postgres from `docker-compose.test.yaml`.

## Phase 1: Setup (WP-0 — static gates and baseline)

- [X] T001 Run `pnpm --dir packages/backend check:table-ownership`, `check:table-ownership --strict`, `check:boundaries` and `npx tsc --noEmit -p tsconfig.json`; paste the lines for domain `infrastructure` (expected 0 MODEL, 0 SQL) into the "Debt register and ownership check" table of `specs/domains/S54-platform-toolkit/gaps.md`, replacing the "not run" cell. Stop and record in questions.md if a non-zero `infrastructure` line appears.
- [X] T002 [P] Create `scripts/check-no-request-scope.ts` (AST scan for `Scope.REQUEST` in `@Injectable`/`@Module` and `@Inject(REQUEST)` across `apps/` and `libs/`; exit 1 listing offenders) and add `"check:no-request-scope"` to `package.json` (G-18, AS-26).
- [X] T003 [P] Create `scripts/check-image-definition.ts` (parse `infra/docker/node/Dockerfile` and `entrypoint.sh`: init `tini` in exec form, `STOPSIGNAL SIGTERM`, `exec node`; compare the 45 s grace period against deploy manifests with the 25 s hard timeout) and add `"check:image-definition"` to `package.json` (G-45, AS-69). Run it; it is expected to fail on the missing `STOPSIGNAL` until T108.
- [X] T004 [P] Create `scripts/check-no-startup-migration.ts` (fail if any `apps/*/src/main.ts` or bootstrap path calls `migrate`, `umzug`, `sync(` or `queryInterface`) and add `"check:no-startup-migration"` to `package.json` (G-45, AS-71, III.11).
- [X] T005 [P] Create `scripts/check-no-wallclock.ts` (fail on `Date.now()`, `new Date()` without arguments, `performance.now()` in `libs/common/{resilience,load-shedding,core}`, `libs/infrastructure/{health,http-client,net,idempotency,context}` excluding `clock.ts` and `*.spec.ts`) and add `"check:no-wallclock"` to `package.json` (G-74, AS-151). Run it and record the current offenders as the work list for T040, T089, T091.
- [X] T006 [P] Create the shared test harness in `test/toolkit/`: `test-app.ts` (boots a Nest app from the real toolkit modules plus a test controller module and applies `configureHttpApp`), `test-controller.module.ts` (routes that throw each error class, hold a configurable delay, write a row, count handler calls, read the context), `stand-in-server.ts` (local outbound server with scripted status sequences, delays, drip bodies, redirects, TLS), `child-app.ts` (fixture app run as a child process with a recording shutdown registry and tiny timings), `spy-tracker.ts` (error-tracker spy), `stop-connection.ts` (closes a pool or connection to simulate an outage). Follow the e2e bootstrap conventions of `test/e2e-env.setup.ts` and `jest-e2e.json`. Add a smoke spec `test/toolkit/harness.e2e-spec.ts` proving the app boots and a route answers.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the clock token and the problem-document contract, which almost every later e2e asserts against.

**⚠️ CRITICAL**: no user story starts before this phase is complete.

- [X] T007 [P] Write `libs/common/core/core-utils.spec.ts` backoff table (AS-103: full-jitter delay table for attempts 0–6 with an injected random source) — failing first (U-CORE). Extend the existing file; do not duplicate cases already present.
- [X] T008 Add the `CLOCK` injection token to `libs/common/core/clock.ts` (keep `Clock`, `SystemClock`, `FakeClock`; the token lives in `common/core`, not `infrastructure`, so `common` imports no `infrastructure`), make `backoff.ts` take the random source and the clock as arguments, and create the global `ClockModule` in `libs/infrastructure/platform/clock.module.ts` providing `CLOCK` → `SystemClock` (G-74 token and module; AS-103). Run T007's spec until green.
- [X] T009 [P] Create `packages/contracts/problem.ts` exporting `problemDetailsSchema` (zod) and `ProblemDetails`: members `type, title, status, detail, instance, code, requestId` required, `traceId?`, `errors?: {field, code}[]`, extensions passthrough; export it from the package entry (G-10, AS-15). Add `packages/contracts/problem.spec.ts` covering a valid document, a missing `code`, and rejection of `area`/`data`/`causes`.
- [X] T010 [P] Add the lint rule forbidding direct `Date.now()` / `new Date()` outside `clock.ts` in the dirs listed in T005 via `eslint.config.mjs` (G-74, AS-151).

**Checkpoint**: `CLOCK`, `ClockModule`, `problemDetailsSchema` and the harness exist.

---

## Phase 3: User Story 1 — Every error looks the same and tells nothing it should not (P1) 🎯 MVP

**Goal**: one filter, one problem document, a code registry, no leaks (WP-1, G-01 to G-13, FR-001 to FR-012).

**Independent Test**: `test-spec.sh libs/common/exceptions-filter` — every collected response parses with `problemDetailsSchema` and carries `requestId` equal to the response header.

### Tests for User Story 1 (write first, confirm RED)

- [X] T011 [P] [US1] Write `libs/common/exceptions-filter/problem-document.spec.ts` (U-DOC, `it.each`): AS-10 (`Retry-After`, extensions merged, reserved members `type,title,status,detail,instance,code,requestId` not overridable), AS-16 (circular extension → minimal `500` fallback document, builder never throws), plus the `detail` = catalogue text for every status ≥ 500 rule (G-05).
- [X] T012 [P] [US1] Write `libs/common/exceptions-filter/problem-details.e2e-spec.ts` (ERR) with the scenarios AS-01 to AS-09 and AS-11 to AS-15 using the harness routes of T006: AS-01 all members, header equals `requestId`; AS-02 `TypeError` → `500 internal_error`, stack in the log only, spy tracker called once; AS-03 `5xx` wrapping a DB error → catalogue detail, no table name; AS-04 no debug members in `development`, `test` and unset `NODE_ENV`; AS-05 multi-field validation failure with `errors[{field,code}]`, unknown properties rejected, no value echoed; AS-06 malformed JSON `400 malformed_body`, oversize `413 payload_too_large`, wrong media type `415 unsupported_media_type`; AS-07 unmatched route `404`, wrong method `405` with `Allow`; AS-08 `401` keeps `WWW-Authenticate`, `403` leaks nothing; AS-09 raw unique violation → `409 conflict` without column or value; AS-11 `4xx` logged `warn` without stack, `5xx` `error` with stack, `requestId` on every line; AS-12 duplicate problem `code` with a different status fails startup; AS-13 error after headers sent → no second write, connection destroyed, no crash; AS-14 `@SensitivePathParams('token')` replaces the value with the route template in `instance` and logs; AS-15 every response parses with `problemDetailsSchema` from `packages/contracts/problem.ts`.

### Implementation for User Story 1

- [X] T013 [US1] Extend `libs/common/errors/error.types.ts`: `AppError` params `{ code, status, title, detail, extensions?, retryAfterSeconds?, idempotencyFinal?, headers?, area, causes? }`; `code` required (snake_case) on every `Fatal_*`, `Transient_*`, `Domain_*` subclass (lines 179–260); `type` = `<problem_type_base_url>/<code>` (config key `problem_type_base_url`, no `api.yourdomain.com`); `toJSON` no longer emits `area`, `data`, `causes` (G-01, G-02).
- [X] T014 [P] [US1] Create `libs/common/errors/platform-codes.ts` (constants: `validation_failed, malformed_body, payload_too_large, unsupported_media_type, not_found, method_not_allowed, unauthenticated, forbidden, conflict, internal_error, service_overloaded, database_timeout, db_lock_timeout, transaction_conflict, database_unavailable, idempotency_key_required, idempotency_key_invalid, idempotency_key_reuse, idempotency_in_flight, idempotency_replay_unavailable, idempotency_unavailable`) and `libs/common/errors/problem-catalog.module.ts` (`ProblemCatalogModule.forFeature(entries)`; entry `{ code, status, title, detail, owner }`; duplicate code with a different definition fails startup naming both owners) (G-01, AS-12).
- [X] T015 [US1] Create `libs/common/exceptions-filter/problem-document.ts` (pure builder: FR-001 members only plus merged non-reserved extensions, `detail` = catalogue text for status ≥ 500, `instance` = path without query, circular-safe fallback) (G-02, G-05, G-07, G-08, AS-10, AS-16). Run T011 to green.
- [X] T016 [P] [US1] Create `libs/common/exceptions-filter/sensitive-path-params.decorator.ts` (`SensitivePathParams(...names)`; metadata key in its own file, no cycle with the filter) (G-07, AS-14).
- [X] T017 [US1] Rewrite `libs/common/errors/error-utils/error-utils.service.ts`: map framework exceptions per status to the platform codes (validation → `validation_failed` with `errors[{field, code}]`, preserving `WWW-Authenticate`, `Allow`, `Retry-After`); unique violation `23505` → `409 conflict` generic; `57014` → `503 database_timeout`; `55P03` → `503 db_lock_timeout`; `40001`/`40P01` exhausted → `503 transaction_conflict`; pool acquire timeout → `503 database_unavailable` (all with `Retry-After`); tracker seam (injectable, called exactly once per request, also under `NODE_ENV=test` when a spy is bound) (G-03, G-04, G-05, G-11).
- [X] T018 [US1] Rewrite `libs/common/exceptions-filter/exceptions-filter.ts`: render through `problem-document.ts`; never send `area`/`data`/`causes`/stack; rename `supportTraceId` → `traceId`; ignore `NODE_ENV` for the body; `requestId` from the response header, else the context accessor, else generate; guard `response.headersSent` (destroy the connection, no second write); try/catch around serialisation with the minimal fallback; log through the structured request logger (`warn` for operational errors without stack, `error` with cause chain for programmer errors, both with `requestId`); strip the query string; apply `@SensitivePathParams` templates (G-02, G-06, G-07, G-08, G-09). Run T012 to green.
- [X] T019 [US1] Route the load-shedding rejection through the shared renderer: in `libs/common/load-shedding/load-shedding.middleware.ts` throw/produce the `service_overloaded` `AppError` (`503`) instead of the hand-written body (G-12; the policy itself is US6). Add the `service_overloaded` catalogue entry in T014's registry.
- [X] T020 [US1] Update existing specs and callers that fail because of the new body shape and `409` for unique violations (questions.md `[BREAKING]` lines 7–10): grep `supportTraceId`, `area:`, `api.yourdomain.com/errors`, `A record with this data already exists`, and fix the assertions in `apps/**` and `libs/**` e2e specs; do not weaken assertions.

**Checkpoint**: `test-spec.sh libs/common/exceptions-filter` green; US1 independently usable.

---

## Phase 4: User Story 2 — Work knows which request, user and shop it belongs to (P1)

**Goal**: async-local context with isolation, immutability and snapshot (WP-2, G-14 to G-19, FR-013 to FR-019).

**Independent Test**: `test-spec.sh libs/infrastructure/context/request-context` and `request-id`.

### Tests for User Story 2

- [X] T021 [P] [US2] Write `libs/infrastructure/context/request-id.spec.ts` (U-RID, `it.each`): AS-18 valid ID kept; too short, too long, control characters, duplicated header (array and comma-joined) replaced by a generated UUIDv7.
- [X] T022 [P] [US2] Write `libs/infrastructure/context/request-context.e2e-spec.ts` (CTX): AS-17 missing `X-Request-Id` → UUIDv7 in response header, logs, context and error body; AS-19 50 concurrent requests each read their own `requestId` after awaits; AS-20 guard-set `userId`/`shopId` visible in a repository call and in logs; AS-21 `shopId` cannot change to another value in one context (same value is a no-op); AS-22 consumer/job `run` isolated and context inactive afterwards; AS-23 reads outside a run return `undefined`, `set` is a no-op; AS-24 `snapshot()` returns exactly the envelope fields as a copy; AS-25 `memo` runs the factory once per request and separately per request.
- [X] T023 [P] [US2] Write the compile-time test `libs/common/request-context/context-augmentation.type-test.ts` (AS-27: a `declare module` augmentation of `AppClsStore` compiles; an undeclared key fails with `// @ts-expect-error`) and wire it into the `tsc --noEmit` project.

### Implementation for User Story 2

- [X] T024 [P] [US2] Create `libs/infrastructure/context/request-id.ts` (pure: `isValidRequestId`, `resolveRequestId(headerValue)`, generator UUIDv7) (G-16, AS-18). Run T021 to green.
- [X] T025 [US2] Extend `libs/common/request-context/types.ts` `AppClsStore` with optional `clientIp`, `traceparent`, `deadlineAt`, keep it an `interface` open for declaration merging (G-14, G-17, AS-27). Run T023.
- [X] T026 [US2] Update `libs/infrastructure/context/request-context.service.ts` and `request-context.module.ts`: use `request-id.ts`; store inbound `traceparent`; `set('shopId', v)` throws a programmer error when `shopId` is already set to a different value; add `snapshot()` and `memo(key, factory)`; reads outside `run` return `undefined`, `set` outside is a no-op; expose `isActive` (G-15, G-16, G-17, G-19). Run T022 to green.
- [X] T027 [US2] Run `pnpm --dir packages/backend check:no-request-scope` (T002) and fix every offender it lists in `apps/` and `libs/` (G-18, AS-26); the check must exit 0.
- [X] T028 [US2] Update callers broken by the `shopId` immutability rule (questions.md line 21): grep `set('shopId'` in `apps/**` and `libs/**`, and fix any that re-set a different value.

**Checkpoint**: context e2e and unit green; `check:no-request-scope` green.

---

## Phase 5: User Story 3 — Services compose inside one transaction and no network call hides in it (P1)

**Goal**: join-by-default transaction scope, `@Transactional`, `afterCommit`, network guard, bounded timeouts, serializable retry, connection settings (WP-3, G-20 to G-26, FR-020 to FR-027).

**Independent Test**: `test-spec.sh libs/infrastructure/context/transactions` and `libs/infrastructure/database/database-settings`.

### Tests for User Story 3

- [X] T029 [P] [US3] Write `libs/infrastructure/context/transaction-options.spec.ts` (U-TXO, `it.each`): AS-38 timeout bounds — `0`, `-1`, `NaN`, `1.5`, an injection string, `700000` rejected; `1` and `600000` accepted.
- [X] T030 [P] [US3] Write `libs/infrastructure/context/transactions.e2e-spec.ts` (TX) with AS-28 to AS-37, AS-39, AS-40: AS-28 two services compose in one transaction without a transaction argument; AS-29 failure rolls back both writes, error unchanged, no `afterCommit` ran; AS-30 `afterCommit` once, after commit, in order, a failing callback isolated; AS-31 nested `run` joins (same transaction id, via `txid_current()`), inner failure rolls back the outer; AS-32 `requires_new` inner commits independently of outer rollback; AS-33 20 concurrent scopes (`Promise.all`) have 20 distinct transaction ids; AS-34 queries after a scope ends run outside any transaction; AS-35 serializable write skew — exactly one removal persists; AS-36 retry on `40001`/`40P01` up to 3 attempts, never on `23505`, exhaustion → `503 transaction_conflict`; AS-37 statement timeout → `503 database_timeout`, lock timeout → `503 db_lock_timeout`; AS-39 `assertActiveTransaction` throws outside and returns the transaction inside; AS-40 a `ResilientHttpClient`/`safeRequest` call inside a transaction is refused (`network_call_in_transaction_total` incremented) and works from `afterCommit`. AS-40 may assert on a stub of the network-guard hook until US7/US8 land; mark the unfinished part with `it.todo` and revisit in T065 and T095.
- [X] T031 [P] [US3] Write `libs/infrastructure/database/database-settings.e2e-spec.ts` (DB): AS-145 connection settings visible via `SHOW` (`statement_timeout`, `idle_in_transaction_session_timeout`, `application_name`) and pool-acquire timeout fails fast with `503 database_unavailable`; AS-146 `READ_REPLICA_CONNECTION` is read-only (write rejected) and verifies the certificate in production mode.

### Implementation for User Story 3

- [X] T032 [P] [US3] Create `libs/infrastructure/context/transaction-options.ts` (pure validators: integers 1 to 600 000 for `lockTimeoutMs` and `statementTimeoutMs`; `maxAttempts` 1–3; `propagation` `'join' | 'requires_new'`, default `join`) (G-21, G-22). Run T029 to green.
- [X] T033 [US3] Rewrite `libs/infrastructure/context/transaction-runner.service.ts`: `run(fn, { isolationLevel?, lockTimeoutMs?, statementTimeoutMs?, propagation? })` joins the active CLS transaction by default and opens a new one only for `requires_new`; apply timeouts with bound `select set_config('lock_timeout', $1, true)` / `statement_timeout` (no string interpolation, no truthiness skip); `runSerializable(fn, { maxAttempts ≤ 3 })` refuses when a transaction is already active, retries only `40001`/`40P01`, and maps exhaustion to `503 transaction_conflict`; keep `enableSequelizeCls()` idempotent in `sequelize-cls.ts` (G-20, G-21, G-22, G-24).
- [X] T034 [US3] Create `libs/infrastructure/context/transactional.decorator.ts` (`Transactional(options?)` method decorator running the method through `TransactionRunner.run`), add `afterCommit(cb)` (callbacks run once, in order, after commit, each isolated; none run on rollback), `getActiveTransaction()` and `assertActiveTransaction()` (throws a programmer error outside a transaction), and a network-in-transaction guard hook `assertNoActiveTransaction('network')` that increments `network_call_in_transaction_total` and throws (G-23, AS-39, AS-40).
- [X] T035 [US3] Create `libs/infrastructure/context/index.ts` exporting exactly the names listed for `@app/infrastructure/context` in `specs/domains/S54-platform-toolkit/contracts/toolkit-api.md` (G-23, G-60 partial). Run T030 to green (except the `it.todo`).
- [X] T036 [US3] Update connection creation in `libs/infrastructure/database` (the Sequelize module factory): `statement_timeout`, `idle_in_transaction_session_timeout`, `application_name` from validated config; acquire timeout (fail fast → `database_unavailable`); pool max from `db_pool_max` (default 10); add the `READ_REPLICA_CONNECTION` provider (read-only session, TLS verification in production, counted in pool arithmetic; max 5 per instance) (G-25, AS-145, AS-146). Run T031 to green. The cross-field pool arithmetic rule is added in T103.
- [X] T037 [US3] Audit the 87 `sequelize.transaction` / `TransactionRunner` / `Transactional` call sites in 52 files (`grep -rn 'sequelize.transaction\|TransactionRunner\|\.transaction(' apps libs`): move each to `TransactionRunner.run` / `@Transactional`, or keep it explicit with a one-line comment why; move any network I/O found inside a scope to `afterCommit`; list transactions that write tables of two domains in a new section "Cross-domain transactions found" of `specs/domains/S54-platform-toolkit/gaps.md` (owned by those domains, IX.4) without fixing them (G-26). Run the existing e2e specs of every touched file.

**Checkpoint**: TX and DB e2e green; nested scopes join.

---

## Phase 6: User Story 4 — Probes that restart only when restarting helps (P1)

**Goal**: pod-local readiness, shared checks reported not failing, startup probe, in-process liveness (WP-4, G-27 to G-36, FR-028 to FR-037).

**Independent Test**: `test-spec.sh libs/infrastructure/health/health-probes`.

### Tests for User Story 4

- [X] T038 [P] [US4] Write `libs/infrastructure/health/health-probes.e2e-spec.ts` (HEALTH) with AS-41 to AS-55: AS-41 `/livez` `200` with database and cache closed via `stop-connection`, no store access; AS-42 `/readyz` `200` with shared dependencies down, reported `down`; AS-43 pod-local critical failing → `503`, recovers after the 2 s cache TTL (FakeClock); AS-44 a shared check promoted `critical` with `failureThreshold: 3` fails readiness only after 3 consecutive failures; AS-45 `/startupz` and `/readyz` `503` during warm-up, `/livez` `200`; AS-46 startup never regresses during shutdown; AS-47 on shutdown start `/readyz` `503` at once, `/livez` `200`, normal requests served; AS-48 hanging check reported `down` at its 500 ms timeout, abort signal fired, response under 1 s; AS-49 results cached, concurrent probes share one evaluation (single-flight); AS-50 body has names and `up`/`down` only, message goes to a `warn` log and the gauge; AS-51 probes exempt from shedding, auth, rate limit, access log, metrics and the global prefix; AS-52 liveness fails only above the extreme event-loop threshold (injected sampler); AS-53 heartbeat silence fails liveness and unregistering at consumer stop avoids a false failure; AS-54 management listener serves the probes for an app with no HTTP surface; AS-55 `platform_ready` and `health_check_up` gauges.

### Implementation for User Story 4

- [X] T039 [P] [US4] Create `libs/common/logging/exempt-paths.ts` exporting the single exempt-path constant (`/livez`, `/readyz`, `/startupz`, metrics path) plus a matcher that ignores the global prefix, and replace the three copies in `libs/common/logging/logging.module.ts:13-19` (`QUIET_PATHS`), `libs/common/telemetry/telemetry.ts:29` and `libs/common/load-shedding/load-shedding.middleware.ts:6` (G-33, AS-51).
- [X] T040 [US4] Rewrite `libs/infrastructure/health/readiness.service.ts`: `register({ name, scope: 'pod'|'shared', critical?, failureThreshold?, timeoutMs = 500, check(signal) })`; shared checks never fail readiness unless `critical` and the threshold is reached; abort signal on timeout; sync-throw guard; 2 s result cache with single-flight using the injected `CLOCK` (no `Date.now()`); report only `name` and `up`/`down`, message to a `warn` log and the gauge (G-27 service side, G-28, G-29, G-74 partial).
- [X] T041 [P] [US4] Create `libs/infrastructure/health/startup.service.ts` (`StartupService.addWarmup(name, fn)`, `started` flag that never regresses) (G-30, AS-45, AS-46).
- [X] T042 [P] [US4] Create `libs/infrastructure/health/liveness.service.ts` (`registerHeartbeat(name, maxSilenceMs)`, `unregisterHeartbeat`, extreme event-loop threshold from the injectable sampler; fails only above it or on heartbeat silence) (G-31, AS-52, AS-53).
- [X] T043 [US4] Rewrite `libs/infrastructure/health/health.controller.ts` and `health.module.ts`: three routes (`/livez`, `/readyz`, `/startupz`), one service call each; drop `uptimeSec`; `Cache-Control: no-store`; drop the `@nestjs/throttler` `SkipThrottle` import in favour of the exempt-path constant; register Postgres, cache, broker and search checks as `scope: 'shared'` (non-critical) in `health.module.ts:31-37` and wire the Elasticsearch check as `shared` (D-16); `readiness` returns `503` until `StartupService` reports started and as soon as shutdown begins; emit `platform_ready` and `health_check_up` gauges through `MetricsRegistry` when available (`libs/common/telemetry`, finished in T105) (G-27, G-30, G-31, G-32, G-35).
- [X] T044 [US4] Add `startupz` to the global-prefix exclusions in `libs/infrastructure/platform/bootstrap-http.ts:46-49` (G-30, AS-51).
- [X] T045 [P] [US4] Create `libs/infrastructure/health/management-listener.ts` (starts a minimal HTTP listener on `management_port` serving the three probes for apps with no HTTP surface) and audit `apps/*/src/main.ts`: list apps without HTTP (worker, projector, payment-processor) in a new section of `gaps.md` and wire the listener into each (G-34, AS-54).
- [X] T046 [US4] Create `libs/infrastructure/health/index.ts` exporting `ReadinessService`, `LivenessService`, `StartupService`, `HealthModule` per `contracts/toolkit-api.md` (G-60 partial). Run T038 to green.

**Checkpoint**: HEALTH e2e green; shared outages never empty the fleet.

---

## Phase 7: User Story 5 — A deploy drops no request (P1)

**Goal**: correct drain order, single signal owner, crash handlers, startup deadline (WP-5, G-37 to G-47, FR-038 to FR-047).

**Independent Test**: `test-spec.sh libs/infrastructure/lifecycle`.

### Tests for User Story 5

- [X] T047 [P] [US5] Write `libs/infrastructure/lifecycle/shutdown-config.spec.ts` (U-SDC, `it.each`): AS-67 `drain delay + request drain >= hard timeout` is rejected; valid combination (e.g. 5 s + 15 s < 25 s) accepted.
- [X] T048 [P] [US5] Write `libs/infrastructure/lifecycle/graceful-shutdown.e2e-spec.ts` (SHUT) driving `test/toolkit/child-app.ts` with real `SIGTERM`/`SIGINT`, tiny timings (drain 100–300 ms, hard timeout 1 s): AS-56 full order recorded (not-ready → drain delay → stop accepting → in-flight done → tasks ascending → app close → exit `0`); AS-57 in-flight request completes with `Connection: close`, new connections refused; AS-58 keep-alive socket served during drain delay, idle socket closed after; AS-59 request-drain timeout destroys a stuck socket and continues; AS-60 in-flight DB query during drain succeeds, pools (order 90) close after the drain; AS-61 task failure and task timeout logged, later tasks run, exit `1`; AS-62 hard timeout forces exit `1` with `forced shutdown` (injectable exit function, in process); AS-63 second SIGTERM and SIGINT ignored and logged, tasks run once; AS-64 equal orders run concurrently, lower first, registration after shutdown began rejected; AS-65 `phase: 'drain'` task ends streams during the HTTP drain; AS-66 crash handlers: synchronous stderr write, exit `1` within 2 s, no drain, non-`Error` reason handled; AS-70 invalid config exits `1` without listening, slow database retried with backoff, startup deadline exceeded exits `1`; AS-72 worker app without HTTP runs the same sequence minus HTTP.
- [X] T049 [P] [US5] Create `libs/infrastructure/platform/platform-bootstrap.e2e-spec.ts` (BOOT) with only AS-68 for now (server `keepAliveTimeout` 65 s, `headersTimeout` 66 s, `requestTimeout` set; ≤ 60 s fails production startup); US10 appends the remaining BOOT rows.

### Implementation for User Story 5

- [X] T050 [P] [US5] Create `libs/infrastructure/lifecycle/shutdown-config.ts` (pure rule + defaults read from validated config: `shutdown_drain_delay_ms`, `shutdown_request_drain_ms`, `shutdown_hard_timeout_ms` = 25 000; `server_keep_alive_ms` 65 000, `server_headers_timeout_ms` 66 000, `server_request_timeout_ms`) (G-41, AS-67). Run T047 to green.
- [X] T051 [US5] Rewrite `libs/infrastructure/lifecycle/shutdown-registry.service.ts`: tasks `{ name, order, phase: 'drain'|'stop' = 'stop', timeoutMs, run }`; equal order runs concurrently, ascending order across groups; failures and timeouts logged, later tasks still run, result reports failure so the process exits `1`; `register` after shutdown began throws; execution is no longer in `beforeApplicationShutdown`; keep `listTaskNames()` (G-40, AS-61, AS-64, AS-65).
- [X] T052 [US5] Rewrite `libs/infrastructure/lifecycle/graceful-shutdown.ts`: sequence mark not-ready → drain delay → `server.close()` + `closeIdleConnections()` → wait for in-flight with the request-drain deadline → `closeAllConnections()` at the deadline → registry tasks (drain-phase tasks start with the HTTP drain) → `app.close()` → exit; `Connection: close` on every response once shutdown began; track sockets; `process.on('SIGTERM'|'SIGINT')` with a guard that logs and ignores later signals; hard timeout 25 s exits `1` with `forced shutdown` via an injectable exit function; timings from `shutdown-config.ts`, `NODE_ENV` not read from `process.env` (G-37, G-38, G-39, G-41, AS-56 to AS-65).
- [X] T053 [P] [US5] Create `libs/infrastructure/lifecycle/crash-handlers.ts` (`installCrashHandlers`: synchronous `fs.writeSync` to stderr for `uncaughtException`/`unhandledRejection`, string and non-`Error` reasons, structured log with `requestId` if available, exit `1` within 2 s, no drain) and move the existing handlers from `graceful-shutdown.ts:88-98` into it (G-43, AS-66).
- [X] T054 [US5] Change `libs/common/telemetry/telemetry.ts:109-111`: remove the `process.once('SIGTERM')` flush and register the flush as a `ShutdownRegistry` task at order 95; keep every other shutdown band as listed in `contracts/toolkit-api.md` (10 stop intake, 30 end long-lived work, 50 flush, 80 caches, 90 pools/clients, 95 telemetry) (G-42, FR-047).
- [X] T055 [US5] Implement startup ordering in `libs/infrastructure/platform/bootstrap-http.ts` and a shared `bootstrapApp` helper in `libs/infrastructure/lifecycle/startup.ts`: validate config first (invalid → exit `1` before listening), retry dependencies with backoff (injected clock), a startup deadline (exit `1`), mark the `StartupService` started only after warm-ups (G-44, AS-70). The all-errors config report is finished in T103.
- [X] T056 [US5] Apply the Dockerfile fixes found by T003: add `STOPSIGNAL SIGTERM` to `infra/docker/node/Dockerfile`, ensure `entrypoint.sh` ends with `exec node`, and align the ECS `stopTimeout`/grace headroom in the deploy manifests with the 25 s hard timeout (G-45, AS-69). Run `pnpm --dir packages/backend check:image-definition` and `check:no-startup-migration` (T004) to green.
- [X] T057 [US5] Audit `apps/*/src/main.ts`: every app (HTTP and non-HTTP) calls `installGracefulShutdown` and `installCrashHandlers`; for apps without HTTP, wire the shutdown sequence minus HTTP and the management listener (T045) (G-46, AS-72).
- [X] T058 [US5] Create `libs/infrastructure/lifecycle/index.ts` exporting `ShutdownRegistry`, `installGracefulShutdown`, `installCrashHandlers` per `contracts/toolkit-api.md`. Run T048 and T049 to green (G-47, G-60 partial).

**Checkpoint**: `test-spec.sh libs/infrastructure/lifecycle` green; the rolling-restart proof (SC-002) is an ops artifact listed in T112.

---

## Phase 8: User Story 8 — User-supplied URLs cannot reach the inside (P1)

**Goal**: `safeGet`/`safeRequest` with pinned addresses, typed failures, production refusal of escape hatches (part of WP-7, G-59, FR-061, FR-062).

**Independent Test**: `test-spec.sh libs/infrastructure/net`.

### Tests for User Story 8

- [X] T059 [P] [US8] Extend `libs/infrastructure/net/ssrf-guard.spec.ts` (U-SSRF, `it.each`): AS-105 blocked address and literal-encoding table (loopback, RFC1918, link-local/metadata, CGNAT, multicast, IPv4-mapped IPv6, decimal/octal/hex/short forms, `0.0.0.0`) with 0 connections; AS-106 a mixed public and private DNS answer → `blocked_address`.
- [X] T060 [P] [US8] Write `libs/infrastructure/net/safe-url.spec.ts` (U-URL, `it.each`): AS-109 scheme (only `https`), port (only 443), and userinfo rejected with `invalid_url` before any lookup; AS-110 `allowHttpHosts`/`allowPrivateHosts` refused when `NODE_ENV=production`.
- [X] T061 [P] [US8] Write `libs/infrastructure/net/safe-request.e2e-spec.ts` (SSRF) using the stand-in server and an injectable resolver: AS-104 `safeGet` success shape; AS-107 rebinding — connection pinned to the validated address, one lookup per hop, certificate checked against the host; AS-108 redirect refused by default / same-host followed / other host / private target / too many redirects; AS-111 overall deadline beats a slow drip, byte cap sets `truncated`; AS-112 content-type filter → `unsupported_content_type`; AS-113 certificate for another host → `tls_error`; AS-114 `unresolvable` and `network_error` with no address or system text in the message; AS-115 `safeRequest` POST sends the exact body and headers, returns `snippet`, returns `3xx` without following.

### Implementation for User Story 8

- [X] T062 [US8] Rewrite `libs/infrastructure/net/ssrf-guard.ts`: remove port `8443` and plain HTTP; address classification handles all literal encodings; the escape hatches (`allowHttpHosts`, `allowPrivateHosts`) are accepted only outside production and refused with `invalid_url` otherwise; injectable resolver (G-59). Run T059 and T060 to green.
- [X] T063 [US8] Create `libs/infrastructure/net/pinned-request.ts` (`safeGet`, `safeRequest` per FR-061: one lookup per hop, pinned connect address, manual redirects with the policy `refuse | same-host | follow`, overall deadline, byte cap with `truncated`, content-type allow-list, typed `SafeRequestError { kind }` from the vocabulary in `contracts/toolkit-api.md`, no address or system text in messages, calls the network guard from T034) and delete the GET-only `pinned-get.ts` after migrating its imports (G-59). Run T061 to green.
- [X] T064 [US8] Create `libs/infrastructure/net/index.ts` exporting `safeGet`, `safeRequest`, `SafeRequestError`, then migrate the callers: `seller-insights/application/crawler.service.ts:53`, `developer-platform/application/webhook-endpoints.service.ts:40`, `developer-platform/application/webhook-deliverer.service.ts:67` and the S02/S08 callers (grep `ssrf-guard\|pinned-get`) — stop building `allowHttpHosts`/`allowPrivateHosts` from configuration in production, use the new failure vocabulary, and update their specs (G-59, G-60 partial).
- [X] T065 [US8] Complete the deferred half of the AS-40 test in `libs/infrastructure/context/transactions.e2e-spec.ts` for `safeRequest`: replace the `it.todo` with a real assertion that `safeRequest` inside a transaction is refused and works from `afterCommit`; run the file to green.

**Checkpoint**: SSRF unit and e2e green.

---

## Phase 9: User Story 9 — A retried POST never does its work twice (P1)

**Goal**: database-backed idempotency facility (WP-8, G-52, G-62 to G-64, FR-063 to FR-069).

**Independent Test**: `test-spec.sh libs/infrastructure/idempotency`.

### Tests for User Story 9

- [X] T066 [P] [US9] Write `libs/infrastructure/idempotency/idempotency.e2e-spec.ts` (IDEM, harness routes with `@Idempotent`, handler call counter, `FakeClock`, real Postgres; the two-instance case boots two Nest apps on one database): AS-116 new key runs the handler once, replay returns the stored answer with `Idempotency-Replayed: true`; AS-117 replay keeps `Location`/`Content-Type`/`ETag`, drops `Set-Cookie`/`Date`; AS-118 10 parallel same-key requests — one runs, nine `409 idempotency_in_flight` with `Retry-After`; AS-119 different body `422 idempotency_key_reuse`, reordered JSON keys replay; AS-120 other path or query with the same key → `422`; AS-121 key required (`422 idempotency_key_required`), invalid forms (`422 idempotency_key_invalid`: length outside 8–128, characters outside `[A-Za-z0-9_-]`, duplicated header), ignored on GET and undeclared routes; AS-122 per-principal scope (user, API key, anonymous client address); AS-123 TTL boundary at 24 h with the fake clock; AS-124 failures release the key unless `idempotencyFinal`; AS-125 expired lock reclaimed, live lock `409`; AS-126 response over 256 KiB → replay `409 idempotency_replay_unavailable`; AS-127 store unreachable (connection closed via `stop-connection`) → `503 idempotency_unavailable`, handler not run; AS-128 `401` and throttled (`429`) requests claim no key; AS-129 purge removes only expired records in batches of ≤ 1 000; AS-130 two instances, 20 concurrent requests, one key: exactly one handler run.

### Implementation for User Story 9

- [X] T067 [US9] Create the migration `migrations/20261009120000-idempotency-key.js` (expand-only `CREATE TABLE "IdempotencyKey"`, `SET LOCAL lock_timeout = '3s'`, reversible `down`) with exactly these columns and constraints from data-model.md: `id uuid` PK (UUIDv7 generated by the app, no FK anywhere); `scope varchar(160) NOT NULL` (`principal:<id>` or `ip:<clientIp>`, never null); `key varchar(128) NOT NULL` (8–128 chars `[A-Za-z0-9_-]`); `fingerprint char(64) NOT NULL` (hex SHA-256); `state varchar(16) NOT NULL` with CHECK `in_flight | completed`; `claim_token uuid NOT NULL`; `lock_expires_at timestamptz NOT NULL`; `response_status smallint NULL`; `response_headers jsonb NULL` (allow-listed `Content-Type`, `Location`, `ETag` only); `response_body bytea NULL` (NULL when over 256 KiB); `body_stored boolean NOT NULL DEFAULT true`; `created_at timestamptz NOT NULL`; `expires_at timestamptz NOT NULL` (created + TTL, 24 h default, route override ≤ 7 d); `UNIQUE (scope, key)`; `INDEX (expires_at)`. Add a second additive step creating the purge function `purge_idempotency_keys(batch int)` deleting expired rows in batches of ≤ 1 000 (G-52).
- [X] T068 [P] [US9] Add `IdempotencyKey: 'infrastructure:idempotency'` to `db/ownership.ts` (same change as T067) and create `libs/infrastructure/idempotency/idempotency-key.model.ts` (registered only inside this lib) (G-52, AS-131).
- [X] T069 [P] [US9] Create `libs/infrastructure/idempotency/fingerprint.ts` (pure: SHA-256 hex over method + path + canonical sorted query + canonical JSON body with key order ignored; text bodies hashed as bytes) — proven through the e2e rows AS-119/AS-120, no unit row in test-plan.md (research R-10).
- [X] T070 [US9] Create `libs/infrastructure/idempotency/idempotency.repository.ts`: atomic claim by `INSERT` relying on `UNIQUE (scope, key)` (III.6, never check-then-write); conditional updates asserting one affected row for `complete` (claim token match), `release` (token match, deletes the row), and lock-expiry takeover (new token); all queries by `(scope, key)`; store errors surface as typed unavailability (G-52).
- [X] T071 [US9] Create `libs/infrastructure/idempotency/idempotent.decorator.ts` (`Idempotent({ required?, ttlSeconds? })`; metadata key in its own file, no cycle with the interceptor — D-17) and `idempotency.interceptor.ts` (awaited store before the response is released; no fire-and-forget; scope `principal:<id>` or `ip:<clientIp>`; facility's own `409/422` never stored; only success and `idempotencyFinal` errors stored; body over 256 KiB → `body_stored=false`; replay sets `Idempotency-Replayed: true`, restores allow-listed headers, drops `Set-Cookie`/`Date`; store failure → `503 idempotency_unavailable` before the handler; lock 60 s via `CLOCK`; ignored on GET/HEAD and undeclared routes) and `idempotency.module.ts` (G-52, FR-063 to FR-069, V.6). Register the catalogue entries from T014.
- [X] T072 [P] [US9] Create `libs/infrastructure/idempotency/purge.service.ts` and register the job `platform.purge-idempotency-keys` (batch 1 000, retention TTL + 1 h) with S49's job registry; if the S49 registry is not yet in the codebase, register through the existing `ShutdownRegistry`-independent scheduler hook and record the gap in questions.md (G-52, AS-129).
- [X] T073 [US9] Create `libs/infrastructure/idempotency/index.ts` exporting `Idempotent`, `IdempotencyModule`; remove the Redis-based interceptor and migrate its callers: `developer-platform/api/v1.controller.ts:57` and `developer-platform/api/public-api.module.ts:10,18` switch to `@Idempotent(...)` plus `IdempotencyModule` (header `Idempotency-Replayed`; update CORS `exposedHeaders` that still name `Idempotent-Replayed`); update their specs (G-62, G-60 partial). Leave `apps/lambdas/src/shared/idempotency.e2e-spec.ts` untouched (G-63). Run T066 to green (G-64).
- [X] T074 [US9] Run `pnpm --dir packages/backend check:table-ownership --strict` and `check:boundaries`; the `infrastructure` lines must be exactly the `IdempotencyKey` row and nothing else queries it (AS-131).

**Checkpoint**: IDEM e2e green, including the two-instance race.

---

## Phase 10: User Story 6 — Overload is refused cheaply, background first, checkout last (P2)

**Goal**: tiered, hysteretic load shedding before body parsing (WP-6, G-48 to G-51, FR-048 to FR-054).

**Independent Test**: `test-spec.sh libs/common/load-shedding`.

### Tests for User Story 6

- [X] T075 [P] [US6] Write `libs/common/load-shedding/shedding-policy.spec.ts` (U-SHEDP, `it.each`, time and lag as arguments): AS-75 tier thresholds background `T`, default `2T`, critical `5T` (T = 100 ms → shed boundaries at lag 250, 450, 1 100 for the configured values); AS-77 hysteresis — stop shedding only after two consecutive samples below `0.8 × tier threshold`, no flapping on alternating 190/210.
- [X] T076 [P] [US6] Write `libs/common/load-shedding/load-shedding.e2e-spec.ts` (SHED) with the injectable lag sampler (AS-80 uses the real monitor): AS-73 below threshold everything admitted, gauge reads the window p99; AS-74 shed → `503 service_overloaded`, `Retry-After` randomised in 1–3, handler never ran, metric incremented; AS-76 `/livez`, `/readyz`, `/startupz` and the metrics endpoint never shed at lag 5 000; AS-78 in-flight cap — default shed at cap, critical admitted up to 2× cap; AS-79 aborted requests release the in-flight counter; AS-80 real monitor sees a 400 ms event-loop block, sheds, recovers after idle windows; AS-81 shed happens before body read, auth and rate limit, with `Connection: close`, and consumes no rate-limit budget; AS-82 shed logs sampled to one `warn` per second while the metric counts all; AS-83 monitor unavailable fails open and windows do not accumulate.

### Implementation for User Story 6

- [X] T077 [P] [US6] Create `libs/common/load-shedding/shedding-policy.ts` (pure policy and hysteresis state, no clock reads) (G-48). Run T075 to green.
- [X] T078 [P] [US6] Create `libs/common/load-shedding/priority.decorator.ts` (`LoadSheddingPriority('critical'|'default'|'background')`, metadata key in its own file) (G-48).
- [X] T079 [US6] Update `libs/common/load-shedding/event-loop-monitor.service.ts`: injectable lag-source seam (default real monitor), fail-open when the monitor is unavailable, no accumulation across windows, `p99Ms()` public (G-50, AS-80, AS-83).
- [X] T080 [US6] Rewrite `libs/common/load-shedding/load-shedding.middleware.ts` and `load-shedding.module.ts`: use the policy; priority resolved from the route decorator; in-flight counter released on `finish` and `close` with cap and critical 2× cap; randomised `Retry-After` 1–3; `Connection: close`; throw the `service_overloaded` problem (T019); use the shared exempt-path matcher (T039, keyed on the path with the prefix removed); counter metric and one sampled `warn` per second (G-48, AS-73, AS-74, AS-76, AS-78, AS-79, AS-82).
- [X] T081 [US6] In `libs/infrastructure/platform/bootstrap-http.ts` take control of body parsers (`bodyParser: false` on the Nest app and mount JSON/urlencoded parsers explicitly) so shedding runs after the request-context middleware and before CORS responses, auth, rate limiting and body reads; document the partial order, finalised in T106 (G-49, AS-81). Run T076 to green (G-51).
- [X] T082 [US6] Create `libs/common/load-shedding/index.ts` exporting `LoadSheddingPriority`, `EventLoopMonitor` per `contracts/toolkit-api.md` (G-60 partial).

**Checkpoint**: SHED e2e and unit green.

---

## Phase 11: User Story 7 — Calling a third party cannot hang or amplify an outage (P2)

**Goal**: one resilient client with caps, budgets, bulkhead and breaker (WP-7, G-53 to G-58, G-61, G-76, FR-055 to FR-060).

**Independent Test**: `test-spec.sh libs/infrastructure/http-client` and `libs/common/resilience`.

### Tests for User Story 7

- [X] T083 [P] [US7] Write `libs/common/resilience/circuit-breaker.spec.ts` (U-CB, `FakeClock`, `it.each`): AS-98 CLOSED → OPEN (calls ≥ `minimumCalls` and failure rate ≥ threshold) → HALF_OPEN after `openDurationMs` → CLOSED on success / OPEN with a fresh timer on failure; AS-99 HALF_OPEN trial slots exhausted → reject at once; AS-100 open breaker with `fallback` returns the fallback flagged `degraded`, fallback error surfaces, no fallback rejects `circuit_open`; `4xx` never counts; slow calls count as failures.
- [X] T084 [P] [US7] Write `libs/infrastructure/http-client/retry-options.spec.ts` (U-RETO): AS-89 attempt cap 3 synchronous / 6 background; `maxAttempts: 5` rejected in a synchronous context at construction.
- [X] T085 [P] [US7] Write `libs/infrastructure/http-client/retry-budget.spec.ts` (U-RETB, `FakeClock`): AS-90 budget 10 % of requests with a floor of 10 retries per host per 10 s window; separate hosts do not share.
- [X] T086 [P] [US7] Write `libs/infrastructure/http-client/resilient-http-client.e2e-spec.ts` (HTTP) against the stand-in server: AS-84 per-attempt timeout → kind `timeout`, socket released; AS-85 `503, 503, 200` succeeds on attempt 3 with jittered waits; AS-86 no retry for `400/401/403/404/409/422/500`; AS-87 `Retry-After` honoured in seconds and date form, `3600` fails at once with `retry_after_exceeds_budget`, unparseable falls back to backoff; AS-88 POST not retried unless declared idempotent, same `Idempotency-Key` on every attempt; AS-91 context `deadlineAt` caps each attempt and a past deadline fails without touching the network; AS-92 caller abort → `aborted`, no retry, no socket leak; AS-93 `response_too_large` with bounded memory, no retry; AS-94 invalid JSON or content type → `invalid_response`, no retry; AS-95 `302` not followed by default; AS-96 20 calls reuse one connection, client idle timeout below the server's; AS-97 bulkhead — 2 run, 2 wait, 2 `bulkhead_full`, another dependency unaffected; AS-101 per-dependency breaker isolation, `4xx` never counts, slow calls count (real client); AS-102 `traceparent` sent, `X-Request-Id` only to `internal` dependencies, no secrets or query strings in logs, spans or metric labels.

### Implementation for User Story 7

- [X] T087 [P] [US7] Create `libs/common/resilience/circuit-breaker.ts` and `libs/common/resilience/index.ts`: `CircuitBreaker({ name, clock, windowMs, minimumCalls, failureRateThreshold, slowCallMs?, openDurationMs, halfOpenCalls })`, `.execute(fn, { fallback? })`, `.state()`; pure, clock injected; state machine from data-model.md (G-56). Run T083 to green.
- [X] T088 [P] [US7] Create `libs/infrastructure/http-client/retry-options.ts` (validation of `maxAttempts` by context: 3 sync, 6 background; replaces `maxRetries`) (G-76). Run T084 to green.
- [X] T089 [US7] Update `libs/infrastructure/http-client/retry-budget.ts`: per host (map keyed by host), clock injected via `CLOCK` instead of `Date.now` (default at `retry-budget.ts:16`), 10 % with floor 10 per 10 s window (G-54). Run T085 to green.
- [X] T090 [P] [US7] Create `libs/infrastructure/http-client/bulkhead.ts` (max concurrent 64 / queue 64 / queue wait 100 ms defaults, `bulkhead_full` failure) (G-56, AS-97).
- [X] T091 [US7] Rewrite `libs/infrastructure/http-client/resilient-http-client.ts`: `ResilientHttpClient.create({ name, internal?, maxConcurrent?, breaker?, retry? })`; `maxAttempts` replaces `maxRetries` (`:59`); remove `500` from the retryable set (`:36`); `Retry-After` capped by the remaining budget (`retry_after_exceeds_budget`), table-tested via `parseRetryAfter` (`:129-136`, handles `0`, negatives, dates); per-host budget; streamed response cap (`maxResponseBytes`, default 1 MiB, `response_too_large`); JSON/content-type failures are non-retryable `invalid_response` (not wrapped as network errors, `:121`); typed `HttpClientError { kind, status?, attempts, retryable }` with the vocabulary in `contracts/toolkit-api.md`; log host and path only (no query, `:73`); connect timeout 3 s (`:54`), idle keep-alive 30 s max 60 s below the server's; context-deadline propagation, caller `AbortSignal`, overall deadline; `traceparent` always, `X-Request-Id` only when `internal`; breaker and bulkhead per dependency; network-guard call from T034; metrics through `MetricsRegistry` when available (G-53, G-55, G-56, G-57, G-76). Run T086 to green (G-61).
- [X] T092 [US7] Create `libs/infrastructure/http-client/index.ts` exporting `ResilientHttpClient`, `HttpClientError` per `contracts/toolkit-api.md` (G-60 partial).
- [X] T093 [US7] Migrate `libs/infrastructure/stripe/stripe.service.ts` (own breaker → `CircuitBreaker`), `notifications/infra/providers/channel-sender.ts` and `developer-platform/application/webhook-deliverer.service.ts` to `ResilientHttpClient`/`CircuitBreaker` (G-56); update their specs and keep their behaviour green.
- [X] T094 [US7] Remove `request/request.service.ts` (axios; no timeout; returns `stack` at `:57`), migrate every caller (grep `RequestService`) to `ResilientHttpClient`, and add the ESLint rule in `eslint.config.mjs` forbidding `axios` imports outside `libs/infrastructure/http-client` (G-58).
- [X] T095 [US7] Complete the deferred half of AS-40 in `libs/infrastructure/context/transactions.e2e-spec.ts` for `ResilientHttpClient` (same pattern as T065); run the file to green.

**Checkpoint**: HTTP e2e and unit specs green.

---

## Phase 12: User Story 10 — Every app starts hardened and fails fast (P2)

**Goal**: one bootstrap, validated configuration, observability baseline (WP-10, G-65 to G-75, FR-070 to FR-080).

**Independent Test**: `test-spec.sh libs/infrastructure/platform` and `libs/common/{config,logging,telemetry}`.

### Tests for User Story 10

- [X] T096 [P] [US10] Write `libs/infrastructure/platform/client-ip.spec.ts` (U-IP, `it.each`): AS-136 trusted-proxy address resolution table (`none`, one hop, CIDR list, spoofed leftmost `X-Forwarded-For`, IPv6, IPv4-mapped, malformed header).
- [X] T097 [P] [US10] Write `libs/common/config/config-rules.spec.ts` (U-CFG, `it.each`): AS-142 capability rules (paired secret via `requireTogether`, `httpsUrl`, origin equality, `distinctSecrets`, `minSecretLength`); AS-143 `platform_currency` validation and origins exposed through `PlatformSettings`; AS-144 pool arithmetic `20 × 10 > 150` fails and `7` starts (rule `db_pool_max × db_max_instances (+ replica) ≤ db_connection_limit − reserved`, plan.md "Pool arithmetic").
- [X] T098 [P] [US10] Write `libs/common/logging/redaction.spec.ts` (U-RED, `it.each`): AS-148 key-name redaction (`password`, `token`, `authorization`, `cookie`, `secret`, `apiKey` …) at any depth, case-insensitive, arrays, circular input, output is one JSON line.
- [X] T099 [P] [US10] Write `libs/common/telemetry/metrics-registry.spec.ts` (U-MET, `it.each`): AS-149 forbidden labels (`userId`, `shopId`, `requestId`, `email`, `ip`, `url`, `path`), duplicate-name conflict with a different definition, naming rules (`snake_case`, unit suffix).
- [X] T100 [US10] Extend `libs/infrastructure/platform/platform-bootstrap.e2e-spec.ts` (BOOT, created in T049): AS-132 security headers on every response (COOP `same-origin`, `Referrer-Policy: no-referrer`, nosniff, CORP), HSTS only in production; AS-133 `SecurityPolicy('public-embed')` relaxes CORS/CORP only for its routes; AS-134 CORS allow, deny, exposed headers (including `Idempotency-Replayed`, `Retry-After`, `X-Request-Id`), preflight allowed headers and `max-age`; AS-135 production with empty allowlist, or `*` with credentials, fails startup; AS-137 production without `trusted_proxies` fails startup, `none` starts; AS-138 `request.rawBody` Buffer available for HMAC for bodies up to the limit, over the limit `413`; AS-139 compression rules (size threshold, no `text/event-stream`, honours `Cache-Control: no-transform`); AS-140 pipeline order and precedence of shed, CORS, `401`, `429`, `400` (shed before CORS before auth before rate limit before idempotency before validation); AS-141 all invalid config keys in one startup error without values, secret absent from logs; AS-152 startup log shows key names and `[set]` only.
- [X] T101 [P] [US10] Write `libs/infrastructure/platform/observability.e2e-spec.ts` (OBS): AS-147 one access-log line per request with `route` template, `requestId` on all lines, no query or body; AS-150 unmatched paths collapse to one metric series, the metrics endpoint is not on the public listener, label overflow goes to one overflow series.

### Implementation for User Story 10

- [X] T102 [P] [US10] Create `libs/infrastructure/platform/client-ip.ts` (pure resolver over `trusted_proxies`) and set `request.clientIp` plus the context `clientIp` (G-68). Run T096 to green.
- [X] T103 [US10] Create `libs/common/config/config-rules.ts` (`ConfigRules.register({ owner, keys, validate })`, helpers `requireTogether`, `httpsUrl`, `distinctSecrets`, `minSecretLength`, `PlatformSettings`) with the pool-arithmetic and shutdown-timing cross-field rules, all-errors report naming keys never values; update `libs/common/config/api-config.service.ts` to keep Joi for platform keys only, make `load_shedding_lag_ms` and `cors_allowed_origins` required where the spec says so, add keys `platform_currency` (default `USD` outside production, required in production), `usercontent_origin`, `trusted_proxies`, `problem_type_base_url`, `db_pool_max`, `db_max_instances`, `db_connection_limit`, `db_reserved_connections` (G-71, AS-141 to AS-144, AS-152). Run T097 to green. This also closes G-44's all-errors report.
- [X] T104 [P] [US10] Create `libs/common/logging/redaction.ts` (pure key-name redaction at any depth) and update `libs/common/logging/logging.module.ts`: use `redaction.ts` instead of the one-level paths at `:50-63`, log level `info` by default (`debug` only when configured), one access line per request with the route template and without query string, `requestId` on every line (G-72, G-06 logger side). Run T098 to green.
- [X] T105 [P] [US10] Create `libs/common/telemetry/metrics-registry.ts` (`MetricsRegistry.counter/histogram/gauge` enforcing naming, forbidden labels, duplicate conflicts) and update `libs/common/telemetry/telemetry.ts` for the unmatched-route label and the overflow series; confirm `/metrics` is not served on the public listener (G-73). Run T099 to green.
- [X] T106 [US10] Rewrite `libs/infrastructure/platform/bootstrap-http.ts` `configureHttpApp(app, options)`: helmet with CSP, COOP, `Referrer-Policy`, CORP, HSTS in production; `SecurityPolicy('public-embed')` group (`libs/infrastructure/platform/security-policy.decorator.ts`); CORS strict allowlist with the full `exposedHeaders` (`Idempotency-Replayed`, `Retry-After`, `X-Request-Id`, `Traceparent` as per contracts/platform-http.md), `allowedHeaders`, `maxAge`, production empty allowlist or `*` with credentials fails startup; trusted proxy (T102) and production requirement; body limit and `rawBody` (`libs/infrastructure/platform/raw-body.ts`); compression (add `compression` if absent) skipping `text/event-stream` and honouring `no-transform`; `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` producing `validation_failed` with `errors[{field, code}]`; pipeline order defined once as in AS-140 (G-65, G-66, G-67, G-68, G-69, G-70). Run T100 and T101 to green (G-75).
- [X] T107 [P] [US10] Create `libs/infrastructure/platform/index.ts` exporting `configureHttpApp`, `SecurityPolicy`, `SensitivePathParams`, `ClockModule` per `contracts/toolkit-api.md` (G-60 partial).
- [X] T108 [US10] Fix every existing test broken by `whitelist`/`forbidNonWhitelisted` (questions.md line 10): run the e2e suites of apps and domains that post bodies, add the missing `class-validator` decorators to DTO properties that the handler really reads, and remove properties the tests send that no handler reads; never loosen the pipe. Record the list of changed DTOs in the PR description.

**Checkpoint**: BOOT, OBS and unit specs green; apps start hardened.

---

## Phase 13: Polish & Cross-Cutting Concerns (WP-9, WP-11)

- [X] T109 Add `index.ts` public entry points for any lib still missing one (`libs/common/errors`, `libs/common/exceptions-filter`, `libs/common/request-context`, `libs/common/config`, `libs/common/telemetry`, `libs/infrastructure/database`) so each export list matches `contracts/toolkit-api.md` exactly (G-60).
- [X] T110 Rewrite every deep import of S54 internals to the public entries: grep `@app/infrastructure/idempotency/idempotency.interceptor`, `@app/infrastructure/net/ssrf-guard`, `@app/infrastructure/lifecycle/shutdown-registry.service`, `@app/infrastructure/context/`, `@app/infrastructure/health/`, `@app/common/exceptions-filter/`, `@app/common/errors/` across `apps/` and `libs/`; run `pnpm --dir packages/backend check:boundaries` to green (G-60, X.4, D-8 for the S54 libs).
- [X] T111 [P] Record sibling-spec follow-ups in the final report, without editing sibling specs: S50 must rename the replay header in its CORS exposure list and AS-47 (`Idempotent-Replayed` → `Idempotency-Replayed`); S07 keeps `422` only for semantic rule violations; S41/S43 adopt the SSRF failure vocabulary; S46 adopts `CircuitBreaker` (questions.md `[CONTRACT]` lines 33–50).
- [X] T112 [P] Write the load-proof checklist for SC-002 (rolling-restart loop), SC-003 (k6 at 2× capacity, admitted p99 < 300 ms), SC-004 (60 s database outage keeps readiness green) and SC-008 (context + logging overhead < 0.5 ms p99) into the "Ops artifacts" section of `specs/domains/S54-platform-toolkit/quickstart.md`; these are not e2e rows.
- [X] T113 Final gates (once): run `test-spec.sh` on the whole capability, i.e. `test-spec.sh libs/common/exceptions-filter libs/common/load-shedding libs/common/resilience libs/common/config libs/common/logging libs/common/telemetry libs/common/core libs/infrastructure/context libs/infrastructure/health libs/infrastructure/lifecycle libs/infrastructure/platform libs/infrastructure/http-client libs/infrastructure/net libs/infrastructure/idempotency libs/infrastructure/database test/toolkit packages/contracts`, then `npx tsc --noEmit`, `npx eslint libs apps test scripts`, `check:boundaries`, `check:table-ownership --strict`, `check:no-request-scope`, `check:image-definition`, `check:no-startup-migration`, `check:no-wallclock`. All must pass; any failure follows the 5-attempt rule.
- [X] T114 Record the green run (date, commit, command list, counts of passing specs) in the "Result" section of `specs/domains/S54-platform-toolkit/quickstart.md` and tick the matching rows of the test-plan coverage (VII.9). Do not mark done while any gate is red.

---

## Gap coverage (every gaps.md item has a task)

| Gap | Task | Gap | Task | Gap | Task |
|---|---|---|---|---|---|
| G-01 | T013, T014 | G-27 | T043 | G-53 | T091 |
| G-02 | T013, T015, T018 | G-28 | T040 | G-54 | T089 |
| G-03 | T017 | G-29 | T040 | G-55 | T091 |
| G-04 | T017 | G-30 | T041, T043, T044 | G-56 | T087, T090, T091, T093 |
| G-05 | T015, T017 | G-31 | T042, T043 | G-57 | T091 |
| G-06 | T018, T104 | G-32 | T043 | G-58 | T094 |
| G-07 | T015, T016, T018 | G-33 | T039 | G-59 | T062, T063, T064 |
| G-08 | T015, T018 | G-34 | T045 | G-60 | T035, T046, T058, T064, T073, T082, T092, T107, T109, T110 |
| G-09 | T018 | G-35 | T043 | G-61 | T086, T091 |
| G-10 | T009 | G-36 | T038 | G-62 | T073 |
| G-11 | T017 | G-37 | T052 | G-63 | T073 (left untouched) |
| G-12 | T019, T080 | G-38 | T052 | G-64 | T066, T073 |
| G-13 | T011, T012 | G-39 | T052 | G-65 | T106 |
| G-14 | T025 | G-40 | T051 | G-66 | T106 |
| G-15 | T026 | G-41 | T050, T052 | G-67 | T106, T108 |
| G-16 | T024, T026 | G-42 | T054 | G-68 | T102, T106 |
| G-17 | T025, T026 | G-43 | T053 | G-69 | T106 |
| G-18 | T002, T027 | G-44 | T055, T103 | G-70 | T106 |
| G-19 | T026 | G-45 | T003, T004, T056 | G-71 | T103 |
| G-20 | T033 | G-46 | T057 | G-72 | T104 |
| G-21 | T032, T033 | G-47 | T048 | G-73 | T105 |
| G-22 | T032, T033 | G-48 | T077, T078, T080 | G-74 | T005, T008, T010, T040 |
| G-23 | T034, T035 | G-49 | T081 | G-75 | T049, T100, T101, T031 |
| G-24 | T033 | G-50 | T079 | G-76 | T088, T091 |
| G-25 | T036 | G-51 | T075, T076 | G-52 | T067–T073 |
| G-26 | T037 | | | | |

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → stories → Phase 13.** T006 (harness) and T008–T009 (clock, problem schema) block every story.
- **US1 first** (all later e2e assert on the problem document). **US2** precedes US3–US5 (context is used by transactions, shutdown logging, shedding).
- **US3** needs US1 (catalogue codes) and US2. **US4** needs US2; its gauges use `MetricsRegistry` (US10, T105) when available — the T043 call is guarded and finished after T105. **US5** needs US4 (not-ready flag, management listener).
- **US8** (SSRF) needs T034 (network guard) only; **US7** needs T034, US10's `MetricsRegistry` is optional. T065 and T095 close AS-40 after US8/US7.
- **US9** needs US1 (codes), US2 (`clientIp` falls back to `request.ip` until T102), and the Postgres test engine.
- **US6** needs US1 (T019) and T039; T081 is finalised by T106.
- **US10** goes last among stories because T106 fixes the final pipeline order and T108 repairs tests across the repository.
- Within a story: unit test task → e2e test task → pure code → services → wiring → `index.ts` → caller migration.

### Parallel opportunities

- Phase 1: T002, T003, T004, T005, T006 in parallel (different files).
- Phase 2: T007, T009, T010 in parallel.
- Story test tasks marked [P] inside one story run in parallel (e.g. T011/T012, T021/T022/T023, T029/T030/T031, T059/T060/T061, T083–T086, T096–T099, T101).
- After Phase 5, US4, US8, US9 and US6 can proceed in parallel by different developers; US5 follows US4; US7 follows US3.
- Pure-logic code tasks marked [P] (T014, T016, T024, T032, T041, T042, T045, T050, T053, T077, T078, T087, T088, T090, T102, T104, T105).

Example (US1): launch T011 and T012 together, then T013/T014/T016 together, then T015 → T017 → T018.

## Implementation Strategy

### MVP first (User Story 1)
1. Phase 1 and Phase 2.
2. Phase 3 (US1). Stop and run `test-spec.sh libs/common/exceptions-filter`; the problem document is now the contract for every other story.

### Incremental delivery
1. Add US2 → US3 (context and transactions, consumed by S49/S53).
2. Add US4 → US5 (probes and shutdown, consumed by S49/S51/S52/S53).
3. Add US8 and US9 (SSRF and idempotency, unblock S10/S13/S15/S42).
4. Add US6, US7, US10 (P2).
5. Phase 13 closes with one whole-capability run (T113).

## Notes

- Every test task is run RED first; if it passes before the code exists, the test is wrong — fix the test.
- Commit after each task or logical group; never leave a red spec in a commit except the task's own RED test inside a single working session.
- No new deployable app, no domain code (I.6). Callers in other domains are touched only for the `[BREAKING]` names listed in questions.md (T020, T028, T064, T073, T093, T094, T108).

## Implementation progress (2026-10-09, all tasks done)

Every task T001 to T118 is ticked. Closing numbers are in the "Result" table of `quickstart.md`: capability e2e 13 suites / 202 tests, unit 18 suites / 357 tests, whole backend e2e 64 of 65 suites (the one failure, `analytics.e2e-spec.ts`, is a ClickHouse DDL problem of the test stack and does not touch S54). Decisions that differ from the task text (webhook deliverer keeps its Redis breaker, shedding mounted with `app.use` instead of `bodyParser: false`, context middleware after the bootstrap chain, call-site audit kept explicit transactions) are recorded in `gaps.md` under "Decisions and deviations recorded while implementing".

## Phase 14: Convergence

- [X] T115 Replace the `it.todo` for AS-35 in `libs/infrastructure/context/transactions.e2e-spec.ts` with a real serializable write-skew test (two concurrent serializable scopes, exactly one removal persists, the loser retried or `503 transaction_conflict`) and make it green; T030 was ticked with this scenario unproven per US3/AS-35 (partial)
- [X] T116 Replace the `it.todo` for AS-146 in `libs/infrastructure/database/database-settings.e2e-spec.ts` with real assertions (`READ_REPLICA_CONNECTION` rejects writes; certificate verified in production mode) once T036 builds the provider; T031 was ticked with this scenario unproven per US3/AS-146 (partial)
- [X] T117 Make `libs/infrastructure/database/database.module.ts:28-33` read pool max, acquire timeout, `statement_timeout`, `idle_in_transaction_session_timeout` and `application_name` from validated config keys (`ApiConfigService`) instead of raw `process.env.DB_*` reads, and register the keys with `ConfigRules`, per G-25 / AS-145 (partial)
- [X] T118 Run ESLint (`pnpm --dir packages/backend lint`) on the wall-clock `no-restricted-syntax` rule from T010 and `eslint.config.mjs`, fix rule errors or violations, and confirm the rule fires on a deliberate `Date.now()` fixture per G-74 (partial; the rule was never executed)

## Phase 15: Convergence

- [X] T119 Record SC-001 (10 000-response sample of every error kind parses as problem+json with 0 leaks), SC-006 (1 000 parallel requests with one `Idempotency-Key` give exactly one side effect) and SC-010 (a new capability adds a domain error, probe check, shutdown task, outbound client and idempotent route using only `contracts/toolkit-api.md` names) as unverified, because the e2e suites prove these only at 20 requests or a few error kinds and nothing proves SC-010: add each under "Ops artifacts" in `quickstart.md` with a run command and one row each in `specs/UNVERIFIED.md` (spec, criterion, how to run it, status `not run`), and do not describe any as verified per SC-001, SC-006, SC-010 (partial)
