# Implementation Plan: S45 — Seller discount functions (domain `shop-functions`)

**Branch**: `S45-discount-functions` | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (39 scenarios, FR-001–FR-037, SC-001–SC-009), `test-plan.md`, `gaps.md` (G-01–G-31, section 2 debt rows, section 3 ownership), `questions.md` (defaults accepted), constitution v3.1.0, and the follow-ups listed under "Follow-ups from built specs" below.

## Summary

Rebuild the single-service `shop-functions` domain (one 303-line service, one module file with an inline controller and judge worker, a 3-test e2e that calls the service directly) into the layered shape of I.1 with three deployables:

- **core** `ShopFunctionsModule`: the management routes (`api/`), `DiscountEvaluationService` (R1 for orders), the cache/breaker/memo stores.
- **worker** `FunctionJudgeModule`: the judge **coordinator** (claims a version, persists verdicts, state transitions), the recovery job and the backlog gauge. It holds database credentials but **never executes seller code**.
- **function-runner** (new, I.6 reason in Constitution Check): a credential-less, network-less process that receives `{source, cases, budgets}` from the coordinator over a Unix domain socket and returns verdicts. Seller code runs there for the judge; checkout evaluation still runs the sealed isolate in-process in core (spec Assumptions "Judge placement").

Behaviour moves from "per-line unit prices, `Math.min`, shared per-source isolate, live test suite, dual-write enqueue" to "one integer per shop, fresh isolate per run, frozen suite per version, outbox hand-off, conditional state machine with history, store-enforced single `ACTIVE`, breaker with half-open trial, entitlement-gated".

State of the tree on 2026-10-17 (read, not assumed):

- Exists and is kept: `infra/sandbox.ts` (isolated-vm 7, 32 MB cap, JSON copy across the boundary; to be reworked, G-24..G-27), `infra/sandbox.spec.ts` (5 tests, extended), the tables from `migrations/20261002150000-shop-functions.js` (expanded, G-29), wiring in `apps/core` (`ShopFunctionsModule`) and `apps/worker` (`FunctionJudgeModule`).
- Delivered by siblings and used here: S49 jobs (`declareJobType`, `JobsService.upsertSchedule`, `InvalidScheduleError`, `fleetConcurrency`), S50 `definePolicies`, S53 outbox (`append`/`appendTask` in the caller's transaction) + consumer framework, S54 `TransactionRunner`/`@Transactional`, S18 `EntitlementsService.getMany/hasEntitlement` and `RequiresShopEntitlement`, S03 `ShopScoped`.
- **Missing upstream, handled with the spec's stated fallbacks (see research D-12, D-13)**: the `functions.manage` permission (tenancy `ROLE_PERMISSIONS` has only `shop.manage`, `domain/permissions.ts:23`) and the `shopFunctions` entitlement key (not in billing's allowlist). Until the siblings add them this capability uses `ShopScoped('shop.manage')` (same role set, OWNER and ADMIN) and the entitlement guard through a single local constant, and lists both under *Sibling-spec follow-ups* in `gaps.md`. Nothing in S03/S18 is edited here.
- **No living spec page exists** (`docs/spec/capabilities/S45-*.md` is absent). Written first, before code (cross-spec rule 0), then kept true by `python3 scripts/livespec/check.py`.

Order of dependency (maps to `gaps.md` §4):

1. **Living page + pure domain** (`domain/`): `version-state.ts`, `discount-amount.ts`, `breaker.ts`, `contract.ts` (strict zod input/output), `errors.ts`, `ports.ts`. Table-driven unit specs, `fast-check` property.
2. **Sealed runtime** (`infra/sandbox.ts`): fresh isolate per run, hardened prelude, classification by isolate state, 64 KiB output cap, `compile-error`/`entry-missing`.
3. **Schema**: one expand/contract migration with `lock_timeout`, registry entry, models, `pg-*` repositories behind port tokens.
4. **Judge**: coordinator service, outbox request in the submit transaction, consumer with zod payload + DLQ, recovery job, backlog gauges; runner program and protocol.
5. **Management API**: controller + DTOs in `api/`, `packages/contracts` schemas, error codes through the global filter, S50 policy, entitlement + permission guards.
6. **Evaluation**: `DiscountEvaluationService`, cache-aside active set, memo, Redis-backed atomic breaker, parallel shops with 200 ms deadline; **orders cut-over** (S10's adapter calls the new service; the `CheckoutDiscounts` port is deleted).
7. **Runner deployment + ops check** `check:function-runner`; static gates (boundaries, ownership); tests per `test-plan.md`.

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS, Sequelize (+sequelize-typescript), zod, `isolated-vm` ^7, `fast-check` for properties.

**Primary Dependencies**: `@app/infrastructure/{outbox,jobs,rate-limit,redis,sqs,platform,context,clock}`, `@app/domains/{tenancy,billing,identity}` entry points (R1 only), `@marketplace-sandbox/contracts`. No new npm package.

**Storage**: Postgres (`ShopFunction`, `ShopFunctionVersion`, `ShopFunctionTestCase`, new `ShopFunctionVersionHistory`); Redis (active-set cache, memo, breaker, failure counters — derived/operational, every key has a TTL, losing them resets to `CLOSED` and a cold cache). The `function-runner` has no store.

**Testing**: jest e2e through `scripts/sdd/test-spec.sh` (real Postgres/Redis/outbox/queue stand-ins, frozen clock, supertest), unit `it.each` + `fast-check`, real sealed runtimes in `sandbox.spec.ts` (no mocks). Test plan: [test-plan.md](test-plan.md).

**Target Platform**: Linux containers; apps `core`, `worker`, and the new `function-runner` (same image family as `infra/docker/node`, different entrypoint and runtime profile).

**Project Type**: backend domain module in a monorepo plus one small deployable program (no web screen: no capability owns a function editor).

**Performance Goals**: warm-cache checkout evaluation for one shop with one healthy function p95 ≤ 15 ms (SC-002; memo hit = one Redis `GET`); 10 shops × 3 timing-out functions < 200 ms; judge of a 50-case suite ≤ 10 s hard, ≤ 5 s typical when idle (SC-004).

**Constraints**: 5 ms per function, 200 ms per call, 50 ms per judge case, 10 s per version, 32 MB per isolate, 64 KiB output, 256 KiB suite body; no network I/O inside a DB transaction; evaluation never rejects.

**Scale/Scope**: 3 functions per shop, 100 versions per function, 50 cases, 50 lines, ≤ 10 shops per cart.

**Connection arithmetic (III.12)**: no new pool. Checkout evaluation holds **no** DB connection on a cache hit and one short read (the active set for the missing shops, one query for all of them) on a miss. The coordinator holds a connection only inside short transactions (claim, apply result); the seller code runs **between** them with no connection held (the runner call can last up to 10 s). Coordinator concurrency per worker instance: 4 judge messages at once, so ≤ 4 connections in the "apply" step, inside the existing pool.

**Isolate budget (questions.md LOCAL "compiled-instance cache size and pre-warm")**: **no compiled-instance cache** (nothing is shared between runs or shops, FR-023). Core keeps a **pool of 4 empty pre-created isolates, single use**: taken, loaded with one source, run, destroyed; refilled asynchronously. Memory ceiling of the pool = 4 × 32 MiB = 128 MiB virtual cap (idle isolates take a few MiB each). Peak concurrent isolates in core are bounded by a semaphore of 8 (another 8 × 32 MiB = 256 MiB cap) so 10 shops × 3 functions queue on the semaphore inside the 200 ms deadline rather than allocate 30 heaps. Judge runner: one isolate per case, one case at a time. See research D-03.

## Constitution Check

| Rule | Status | How the design satisfies it |
|---|---|---|
| I.1–I.3 layers, ports (fixes D-6) | PASS | `api/` controller and DTOs, `application/` use-case services, `domain/` pure rules and port tokens, `infra/` Sequelize repositories, Redis stores, isolate adapter, runner client. No Sequelize or Redis in `application/` |
| I.4 ownership | PASS | tables `ShopFunction`, `ShopFunctionVersion`, `ShopFunctionVersionHistory`, `ShopFunctionTestCase`; Redis prefix `shopfn:`; queue task `shop-functions.judge-version`; jobs `shop-functions.*` |
| I.6 new deployable | PASS (reason recorded) | `function-runner` exists for one reason: **process-level isolation**. Seller code must run where there is no network, no data-store credentials and a read-only root. The worker holds all three, so it cannot host the runner. No other new app. Domain map updated by task (`Hosted by: core, worker, function-runner`) |
| II.1 controller thin | PASS | one service call per route; errors are typed domain errors mapped by the global problem+json filter |
| III.2/III.3 transactions, no I/O inside | PASS | `TransactionRunner.run`/`@Transactional`; the runner call, Redis and the sandbox are outside every transaction; outbox `append` inside the submit transaction; caches dropped **after** commit |
| III.4 tenant predicate | PASS | every principal-driven repository method takes `shopId` (`WHERE f."shopId" = :shopId`); the judge (system actor) loads by `(functionId, version)` only |
| III.5 SQL | PASS | parameterised; no dynamic identifiers |
| III.6 invariants in store | PASS | partial unique index one `ACTIVE` per function; conditional `UPDATE … WHERE status = :from` asserting one row; version number allocated under the function row lock (`SELECT … FOR UPDATE`); function count under a per-shop advisory lock (`pg_advisory_xact_lock(hashtext(shopId))`); case-insensitive unique name; `activeVersion` composite FK to the version row plus the `ACTIVE` guard (research D-07) |
| III.7 state machine | PASS | `domain/version-state.ts` discriminated union with `assertNever`; history row in the same transaction |
| III.8 money | PASS | integer minor units, percentages in basis points, `floor` in integer arithmetic, clamped per line and per shop |
| III.9 caches | PASS | cache-aside, TTL 60 s on every key, never source of truth; `SCAN`-free (keys are exact); the old test's `KEYS` call is removed |
| III.10 cursor | PASS | `(createdAt DESC, id DESC)` for functions, `version DESC` for versions, opaque cursor, `limit` ≤ 50 |
| III.11 migrations | PASS | expand then contract inside one reviewed migration with `lock_timeout`; FK drop is a contract of a constraint nothing reads |
| III.12 connection arithmetic | PASS | see Technical Context |
| IV.1 / IX.4 / IX.7 | PASS | R1 only: `EntitlementsService` (billing), `ShopScoped` (tenancy), `Firewall`/`@User()` (identity); orders imports `DiscountEvaluationService`; **nothing imports orders**; no FK to a foreign table; `index.ts` exports modules, the service and two DTO types |
| IV.3/IV.4 | PASS | judge request = outbox task `shop_functions.judge_requested` appended in the submit transaction, relayed to the single-consumer task `shop-functions.judge-version`; recovery job covers a lost message |
| IV.5 consumers | PASS | zod payload `{functionId: uuid, version: int>0}` strict, DLQ with reason, terminal-state no-op, conditional claim, attempt counter |
| IV.6 timeouts | PASS | 5 ms/50 ms/10 s/200 ms budgets; coordinator → runner socket has a connect and a total deadline (10 s + 2 s); entitlement call bounded by the 200 ms deadline |
| IV.8 ACL | PASS | seller code, its output and the runner's reply are untrusted: strict zod parse of every output and every runner reply |
| V.1–V.4 | PASS | response DTOs and schemas in `packages/contracts`; problem+json codes of FR-034; foreign shop = `404 function_not_found`; no ORM object serialised |
| V.6 idempotency key | N/A | submission is a harmless draft by spec Assumptions; activate and enable/disable are conditional state changes (one wins, the other `409`) |
| VII.2–VII.9 | PASS | four supertest e2e files + four unit specs, one row per AS; judge delivered through the real consumer; no foreign model; fault tests for billing failure, loop, throw, memory, invalid output, corrupt cache entry |
| VIII.1 logs | PASS | structured through the platform logger with `requestId`/`traceId`; never source, test input, discount message or shop/function IDs as labels |
| VIII.5 config | PASS | `ShopFunctionsConfig` zod-validated at start (budgets, limits, TTLs) |
| VIII.6 jobs | PASS | `shop-functions.recover-stuck-versions` every 60 s, `fleetConcurrency: 1`, `declareJobType` with contract next to the `JobPayloads` augmentation, `InvalidScheduleError` caught at boot (S49 follow-up) |
| IX.3 registry | PASS | `ShopFunctionVersionHistory` added to `db/ownership.ts` in the migration's task |
| S54 T037 | PASS | the two direct `sequelize.transaction` sites in `application/shop-functions.service.ts:67,178` (with their `// S54 T037 audit` comments) disappear with the rewrite; none added in this domain |
| L-001 queue option validated at creation | PASS | the task carries no FIFO-only option; payload validated by the producer's schema before `appendTask` |
| L-002 / L-020 queue defined in `elasticmq.conf` | WATCH | the task name changes from `function-test-runs` to `shop-functions.judge-version`; a task adds the queue to `infra/docker/elasticmq` config and the consumer fails readiness while it is missing (T-queue). Reloading the queue server is **not** an agent step; the config edit is the deliverable |
| L-015 / L-018 app boots on its own | PASS (by design, runtime proof deferred) | `ShopFunctionsModule`, `FunctionJudgeModule` and `function-runner` each declare their own imports (no `@Global()`); runtime boots are the final checkpoint's, not a task here |
| L-017 scenarios survive file changes | PASS | the three old e2e scenarios (judge verdicts, own-shop checkout, fail-safe + breaker) map to AS-10/13, AS-24/25, AS-28/29 before the old file is deleted |

No violations; Complexity Tracking is empty. **Post-design re-check**: unchanged after Phase 1. The one judgement call (a Unix-socket runner protocol instead of HTTP) is the smallest channel that satisfies "local channel only" and is recorded in research D-05.

## Project Structure

### Documentation (this feature)

```text
specs/domains/S45-discount-functions/
├── spec.md · test-plan.md · gaps.md · questions.md   # inputs
├── plan.md            # this file
├── research.md        # decisions, gap status, follow-ups
├── data-model.md      # tables, constraints, state machine, Redis keys
├── contracts/
│   ├── api.md         # HTTP routes, schemas, error codes
│   └── internal.md    # evaluateDiscounts, judge task, runner protocol, metrics
├── quickstart.md      # run guide + Ops artifacts
└── tasks.md           # /speckit-tasks (not created here)
```

### Source Code

```text
packages/backend/libs/domains/shop-functions/
├── api/
│   ├── shop-functions.controller.ts      # function, tests, enable/disable, delete, list/read
│   ├── function-versions.controller.ts   # submit, list, read, activate
│   ├── dto/                              # class-validator request DTOs (nested, whitelist)
│   └── rate-limit-policies.ts            # shop-functions.submit.shop (10/h, fail closed)
├── application/
│   ├── functions.service.ts              # create, list, read, delete, enable, disable, tests get/put
│   ├── versions.service.ts               # submit, list, read, activate (rollback)
│   ├── judge.service.ts                  # coordinator: claim → runner → apply result
│   ├── judge-recovery.service.ts         # stuck QUEUED/TESTING
│   ├── discount-evaluation.service.ts    # R1 for orders (never rejects)
│   ├── active-set.service.ts             # cache-aside active functions per shop
│   ├── breaker.service.ts                # Redis state + domain/breaker.ts transitions
│   ├── shop-functions.config.ts          # zod-validated budgets and limits
│   ├── shop-functions.metrics.ts         # AS-35/AS-36 metrics
│   ├── shop-functions.job-types.ts       # declareJobType + JobPayloads augmentation
│   └── events/judge-requested.event.ts   # outbox task definition
├── domain/
│   ├── contract.ts                       # strict zod: FunctionInput, FunctionOutput, test case, verdict
│   ├── discount-amount.ts (+ .spec.ts)   # AS-26 integer arithmetic, largest wins
│   ├── version-state.ts (+ .spec.ts)     # AS-21 transition table
│   ├── breaker.ts (+ .spec.ts)           # CLOSED/OPEN/HALF_OPEN table
│   ├── errors.ts                         # typed errors with FR-034 codes
│   └── ports.ts                          # repository, cache, breaker-store, runner, entitlement tokens
├── infra/
│   ├── sandbox.ts (+ sandbox.spec.ts)    # fresh isolate per run, hardened prelude, pool of empty isolates
│   ├── models/                           # ShopFunction, ShopFunctionVersion, ShopFunctionTestCase, ShopFunctionVersionHistory
│   ├── pg-function.repository.ts · pg-version.repository.ts · pg-test-case.repository.ts
│   ├── redis-active-set.cache.ts · redis-memo.cache.ts · redis-breaker.store.ts (Lua: count+expire, half-open trial)
│   ├── runner.client.ts                  # coordinator → runner over a Unix socket
│   ├── judge.consumer.ts                 # task consumer (zod payload, DLQ)
│   └── judge.jobs.ts                     # recovery job + backlog gauge refresh
├── runner/
│   └── main.ts                           # the function-runner program: socket server over infra/sandbox only
├── shop-functions.module.ts              # core
├── function-judge.module.ts              # worker
├── index.ts                              # ShopFunctionsModule, FunctionJudgeModule, DiscountEvaluationService, DiscountCartDto, DiscountEvaluationDto
├── shop-functions-management.e2e-spec.ts · shop-functions-judge.e2e-spec.ts
├── shop-functions-checkout.e2e-spec.ts · shop-functions-ops.e2e-spec.ts
└── testing/function-fixtures.ts          # seeds (shops, users via shared helpers), sources, failing entitlement fake
apps/function-runner/                     # entrypoint wrapper + tsconfig only (imports nothing from the domain except the built runner)
infra/docker/function-runner/             # Dockerfile / compose service: read_only, network none, user, seccomp, limits
packages/backend/migrations/<ts>-shop-functions-s45.js
packages/backend/db/ownership.ts          # + ShopFunctionVersionHistory
packages/backend/scripts/check-function-runner.ts   # pnpm check:function-runner
packages/contracts/src/shop-functions/    # shopFunctionSchema, shopFunctionVersionSchema, shopFunctionTestSchema, problem codes
docs/spec/capabilities/S45-discount-functions.md   # living spec page (new)
docs/work/architecture/domain-map.md      # shop-functions entry updated (Hosted by, Exports)
```

Deleted at the end: `application/shop-functions.service.ts`, the inline controller/worker in `shop-functions.module.ts`, `shop-functions.e2e-spec.ts` (after L-017 mapping), `orders/domain/checkout-discounts.port.ts`, `orders/infra/discounts.adapter.ts` and the transitional `CheckoutDiscounts`/`DiscountableLine` exports in `orders/index.ts` (the pinned list in `orders-boundary.e2e-spec.ts` shrinks by two lines — see Follow-ups).

**Structure Decision**: extend the existing `shop-functions` domain; add one deployable (`function-runner`) whose program lives **inside the domain** (`runner/main.ts`) so no app imports a domain internal; the `apps/function-runner` folder holds only the entrypoint wrapper. `index.ts` exports exactly what FR-036 lists (D-8 stays clean).

## Follow-ups from built specs (each is a requirement of this plan)

| From | Requirement | Where planned |
|---|---|---|
| S10 | provide `evaluateDiscounts(cart) → {shopDiscounts: [{shopId, discountMinor}]}`; S10 replaces `LegacyCheckoutDiscountsAdapter`; `CheckoutDiscounts` and `DiscountableLine` leave orders' transitional block | `application/discount-evaluation.service.ts`; export from `index.ts`; **orders cut-over task** replaces the adapter's source with the new service (the adapter file is S10's, edited only as the single call site this task changes: the port binding in `orders-core.module.ts`/`infra/discounts.adapter.ts`), deletes the port and the two transitional exports and shrinks the list pinned by `orders-boundary.e2e-spec.ts`. S10's own spec is not edited; if S10's `ShopDiscountsPort` needs a rename it goes under *Sibling-spec follow-ups* |
| S49 | `declareJobType` with a payload contract next to the `JobPayloads` augmentation for `shop-functions.recover-stuck-versions`; adapt to the discriminated result of `JobsService.cancel` (this capability never cancels; stated, not coded); catch `InvalidScheduleError` instead of a generic `Error` | `application/shop-functions.job-types.ts`, `infra/judge.jobs.ts` |
| S49 | `fleetConcurrency: 1` where one run in the fleet is promised | recovery job registered with `fleetConcurrency: 1` (FR-020 "single-run lease", AS-19 two runners at once) |
| S54 T037 | no new direct `sequelize.transaction`; migrate any in touched files and delete the audit comment | both direct sites go away with the service rewrite; `TransactionRunner.run` / `@Transactional` everywhere |
| S03 | `functions.manage` for OWNER and ADMIN | until present: `ShopScoped('shop.manage')` through one constant `FUNCTIONS_PERMISSION`; follow-up bullet in `gaps.md` (D-12) |
| S18 | boolean `shopFunctions` entitlement key (free `false`, `pro` `true`), `getMany` batch | read through one constant `SHOP_FUNCTIONS_ENTITLEMENT`; follow-up bullet in `gaps.md`; tests use a billing test double until S18 adds the key (D-13) |
| S50 | register `shop-functions.submit.shop` | `api/rate-limit-policies.ts`, `definePolicies('shop-functions', …)` and the policy-name augmentation, merged where core collects `*RatePolicies` |
| S53 | outbox task + consumer framework | `events/judge-requested.event.ts`, `infra/judge.consumer.ts` |

## Complexity Tracking

None. The new deployable is justified under I.6 above, not a constitution violation.
