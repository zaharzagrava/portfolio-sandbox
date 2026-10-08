# Gaps: S45 — Seller discount functions (domain `shop-functions`)

What the current code gets wrong or lacks versus [`spec.md`](spec.md), the open debt-register rows that touch this capability, and this domain's cross-domain access lines. This is the implementation agent's to-do list. Paths are under `packages/backend/libs/domains/shop-functions/` unless stated otherwise.

Existing tests: `shop-functions.e2e-spec.ts` (3 tests: judge verdicts, own-shop checkout, fail-safe plus breaker) calls `ShopFunctionsService` directly instead of HTTP, spies on `TaskQueue.enqueue` (`:39`), imports tenancy's `ShopModel` (`:11`) and clears Redis with `KEYS` (`:49`); `infra/sandbox.spec.ts` (5 tests over real isolates, the only unit spec, good and kept).

`pnpm --dir packages/backend check:table-ownership` could not be run while writing this file (running it needs an approval that was not available in this unattended session). Section 3 is built from reading the code. **The implementation agent must run it first and replace section 3's findings with the live rows for `shop-functions`; the target is zero.**

## 1. Gaps in the code (spec reference → what is wrong or missing → fix)

### Checkout contract and boundaries

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-01 | FR-025, FR-036, FR-037, AS-24, AS-38 | The checkout hook is `CheckoutDiscounts.unitPrices(lines) → number[]`, an abstract class **defined in orders** (`orders/domain/checkout-discounts.port.ts:14`); `ShopFunctionsService extends CheckoutDiscounts` (`application/shop-functions.service.ts:34`) and imports it (`:8`, `shop-functions.module.ts:8`); the module is `@Global()` and re-provides it (`:43`, `:46`). This is a shop-functions → orders import, the reverse of the domain map (orders depends on shop-functions) and a latent cycle. | Add `DiscountEvaluationService.evaluateDiscounts(cart): Promise<DiscountEvaluationDto>` and the two DTO types; export them from `index.ts` (which today exports only the two modules); delete the `CheckoutDiscounts` port from orders (S10 imports the new service); remove `@Global()` and the `useExisting` provider; no import of `@app/domains/orders` remains. |
| G-02 | FR-025, FR-029, AS-26 | The service returns per-line **unit prices** and applies `Math.min` (`service.ts:121-141`); amounts are never summed per shop, never clamped to the shop gross, and floats are handled with `Math.floor` (`domain/contract.ts:31-32`). | Pure `domain/discount-amount.ts` implementing AS-26 (integer basis points, per-line clamp, per-shop clamp, largest-wins across functions); output is one integer per shop, only `> 0`. |
| G-03 | FR-026, AS-28, AS-34 | `unitPrices` can reject: the active-set load, Redis calls, `JSON.parse` of the cache or memo and `recordFailure` are not wrapped (`:147-156`, `:131-132`); only the sandbox call is fail-safe. | Wrap per function and per shop; the public method never rejects; invalid carts return the empty result with outcome `invalid_cart`. |
| G-04 | FR-028, AS-31 | 5 ms per function exists (`:13`), but there is no overall budget, shops run sequentially (`:126-139`), no parallelism, compile time is unbounded (`infra/sandbox.ts:68` allows 50 ms per compile). | Shops in parallel, functions per shop in name order, 200 ms overall deadline returning completed shops (`budget_exceeded`); compile outside the 5 ms but inside the deadline. |
| G-05 | FR-027, FR-032, AS-32 | No entitlement check anywhere (domain map: depends on billing R1). | Batch `EntitlementsService.getMany('SHOP', shopIds)` once per call (S18; test double until it ships); `not_entitled` and `entitlement_unavailable` outcomes. |
| G-06 | FR-027, AS-25 | Input hard-codes `currency: 'usd'` (`service.ts:129`) and uses `unitPrice` (`domain/contract.ts:4`); `shopId` can be `null` (`orders/domain/checkout-discounts.port.ts:8`) and such lines are silently dropped (`service.ts:124`). | Input `{currency (cart's), lines: [{productId, category, quantity, unitPriceMinor}]}`; null or missing shop makes the cart invalid; no PII, no shop ID in the input (test AS-25). |
| G-07 | FR-030, AS-29 | Breaker: `INCR` then `EXPIRE` as two commands (`:165-167`, a crash between leaves a counter with no TTL), no half-open trial, no state returned to the seller, no metric (`:159-172`). Reasons stored as free text. | Atomic count-and-expire, open for 300 s, single trial after, shared state; surfaced as `breaker` on the function DTO; `shop_functions_breaker_open_total`; pure `domain/breaker.ts` transition table. |
| G-08 | FR-031, AS-30, AS-33 | Memo keyed by `sourceHash` + input hash (`:130`), so two shops with the same source share entries; the active-set cache is deleted **outside** the judge transaction (`:110`) and not at all on disable, enable, delete or rollback (none exist); `JSON.parse(... ?? 'null')` treats a memoized empty array as truthy but a corrupt entry as a throw. | Memo keyed by function version and canonical input; drop caches after commit on every change (activate, rollback, disable, enable, delete); tolerate a corrupt entry as a miss; TTL on every key. |

### Management API and tenancy (`shop-functions.module.ts`, `application/shop-functions.service.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-09 | FR-001, FR-003, AS-04, AS-05 | `ShopScoped('shop.manage')` on both routes (`module.ts:26`, `:32`); no entitlement guard; no read routes. | `ShopScoped('functions.manage')` (S03) above-or-with `RequiresShopEntitlement('shopFunctions')` (S18) on write routes; table test over every route and role. |
| G-10 | FR-004 to FR-009, AS-01 to AS-09 | Only `POST /shops/:shopId/functions` and `POST …/:functionId/versions` exist. Missing: list, read, delete, enable, disable, `GET|PUT …/tests`, version list, read, activate. `create` returns `{functionId}` (`service.ts:60`). | Add all routes of Provides; response DTOs and `packages/contracts` schemas (`shopFunctionSchema`, `shopFunctionVersionSchema`, `shopFunctionTestSchema`); no raw ORM or SQL result is serialised. |
| G-11 | FR-005, AS-02 | `CreateFunctionDto.tests` is an untyped array (`module.ts:14`): no nested validation, no per-case name limit, no input or expected validation, no duplicate check, no suite size cap, no unique function name (the table has `UNIQUE ("shopId", "name")` case-sensitive, surfacing as a 500). | Nested validated DTOs (class-validator at the API; zod for the expected output with the same schema as the sandbox); closed set of errors `validation_failed` and `invalid_test_case`; case-insensitive name uniqueness answering `409 function_name_taken`; global pipe with `whitelist` and `forbidNonWhitelisted`. |
| G-12 | FR-004, AS-03 | No limit on functions per shop. | At most 3 per shop, enforced by the store under concurrency (not check-then-insert): lock or constrained counter; `422 function_limit_reached`. |
| G-13 | FR-002, AS-04 | Reads and writes are principal-scoped in `submit` (`WHERE f."shopId" = :shopId`, `:70`) but `judge` and `active` load by function ID only (`:81-86`, `:147`); `create` writes raw SQL (`:53`). | Every repository method takes the shop where a principal exists; the judge (system actor) loads by function ID and version only; repositories in `infra/` behind domain port tokens (D-6). |
| G-14 | FR-010, FR-011, AS-10, AS-12 | Version number is `max(version)+1` inside one `INSERT … SELECT` (`:67-72`) with no lock: two concurrent submissions can compute the same number and one fails with a PK violation (500). Test cases are not frozen. The judge request is a second write after the insert (`:74`). | Row lock or retry-safe allocation on the function row; freeze the suite as version-keyed test-case rows; history row; outbox `shop_functions.judge_requested` in the same transaction; answer `202`. |
| G-15 | FR-012, AS-11 | No rate limit; no version cap; the `400` for a missing `run` is a regex (`:66`); `length > 20_000` repeated in the service (`:65`) although the DTO has it (`module.ts:19`). | S50 policy `shop-functions.submit.shop`; `422 version_limit_reached` at 100; drop the regex (the judge reports `entry-missing`/`compile-error`). |

### Judge, versions and state machine

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-16 | FR-013, AS-21 | Status updates are bare `UPDATE`s: `TESTING` claim accepts `IN ('QUEUED','TESTING')` (`:81`), the final status is set with no `WHERE status = 'TESTING'` (`:101`), no assertion of one affected row, no history row, no actor. | Pure `domain/version-state.ts` (discriminated union, `assertNever`); conditional updates asserting one row; `ShopFunctionVersionHistory` rows in the same transaction; `timeline` on the version DTO. |
| G-17 | FR-014, FR-015, AS-15, AS-16 | A passing version always becomes `ACTIVE` and demotes the previous one (`:100-107`): a slow older version overwrites a newer one; two concurrent completions can both end `ACTIVE`; nothing in the store stops it. | Stale rule (`SUPERSEDED` with reason `stale`), partial unique index on `(functionId) WHERE status = 'ACTIVE'`, `activeVersion` updated in the same transaction and consistent by constraint. |
| G-18 | FR-016, AS-20 | No rollback route; `SUPERSEDED` is a dead end. | `POST …/versions/:version/activate` for a passed `SUPERSEDED` version; `409 version_not_activatable` otherwise; atomic swap. |
| G-19 | FR-018, AS-13, AS-14 | Judge runs the cases sequentially with no overall deadline (`:90-96`), reads the **live** suite (`:86`), has no `compile-error`/`entry-missing` verdicts (all collapse into `runtime`, `infra/sandbox.ts:39`), keeps `actual` only for wrong output, orders by case name (kept). | Per-version 10 s deadline, frozen suite per version, the eight verdicts, `detail` ≤ 300 characters (kept), `judgedAt`. |
| G-20 | FR-019, AS-17, AS-18 | Redelivery of a finished version returns `null` silently, but the consumer is registered with no payload validation and no DLQ (`module.ts:67`: `({ body }) => judge(body.functionId, body.version)`); a crashed `TESTING` row is re-claimed without an attempt counter; no idempotency tests. | zod-validated payload, DLQ for invalid messages (S53 framework), terminal-state no-op, attempt counter `judgeAttempts`; VII.4 tests (duplicate and invalid payload). |
| G-21 | FR-020, AS-19 | No recovery of versions stuck `QUEUED` or `TESTING`; if the process dies after insert and before enqueue, or the message is lost, the version is stuck forever. | Job `shop-functions.recover-stuck-versions` (S49, every 60 s, single lease): re-request after 2 minutes, max 5, then `REJECTED judge_unavailable`. |
| G-22 | FR-033, AS-36 | No backlog metric, so the judge cannot autoscale on queue depth (SD-40 note). | Gauges `shop_functions_judge_backlog` and `shop_functions_judge_oldest_queued_age_seconds`. |
| G-23 | FR-017, AS-10 | No way to read a version, its verdicts or its source. | `GET …/versions` and `…/versions/:version` (source only for managers). |

### Sealed runtime (`infra/sandbox.ts`, `domain/contract.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-24 | FR-023, AS-14 | The compiled isolate and context are cached by `sha256(source)` (`:27`, `:34`, `:56-76`) and reused across runs, so globals persist between invocations and between **shops** with identical source (a cross-tenant channel). | New context per run (or per-function instance never shared across shops) and no state after a run; cache key includes function and version; clear tests in `sandbox.spec.ts` (global set in one run, absent in the next, absent for another shop). |
| G-25 | FR-022, AS-14 | `Date`, `Math.random`, `eval`, `Function` constructor are available; only Node APIs are absent. Probes for `import()`, `setTimeout`, `globalThis.constructor`, `eval` are missing from tests (`sandbox.spec.ts:26-32` covers three). | Remove or throw for `Date`, `Math.random`, `eval`, `Function` constructor, dynamic import; extend the probe table. |
| G-26 | FR-021, AS-14, AS-26 | Output schema accepts any positive finite `value` up to 1,000,000, a float `fixedPerUnit`, an out-of-range `lineIndex` (skipped later, `contract.ts:31`), no cap on serialised size; `JSON.parse(String(raw))` can throw an unclassified error (`sandbox.ts:37`) and `result` is a string from the isolate. | Strict zod: integer `fixedPerUnit`, percentage `(0,100]` with ≤ 2 decimals, `lineIndex` validated against the input, 64 KiB output cap; parse failures are `invalid-output`. |
| G-27 | FR-022, AS-14 | Error classification is regex over messages: `memory|disposed` counts as memory (`:50`), so a function that disposes or throws a message containing "memory" is misreported; an isolate is evicted only on timeout or memory. | Classify by isolate state and error type, not message text; destroy the instance on any non-`ok` result. |
| G-28 | FR-024, AS-23 | The "second wall" exists only as a comment (`module.ts:57-62`) and a doc line: `FunctionJudgeModule` runs seller code inside a worker that has database, Redis and queue access. There is no `apps/function-runner`, no container profile and no check. | Runner deployment with no network, read-only FS, non-root, default seccomp, no credentials, limits; coordinator/runner split over a local channel; `check:function-runner` ops check; I.6 reason recorded in `plan.md`; domain map updated. |

### Data model and tests

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-29 | FR-035, AS-39 | `migrations/20261002150000-shop-functions.js`: FK `ShopFunction.shopId → "Shop"("id")` (`:9`, IX.4 foreign key to another owner); `ShopFunctionTestCase` has no version column; no partial unique index for one `ACTIVE`; `activeVersion` unconstrained; no history table; no `judgeAttempts`, `rejectionReason`, `judgedAt`, `updatedAt`; no `lock_timeout`; no unique `lower(name)`; no model classes (raw SQL everywhere). | Expand/contract migration with `lock_timeout`: drop the FK; add `version` to test cases, `ShopFunctionVersionHistory`, the columns above, the partial unique index, a composite FK from `activeVersion` to a version row or an equivalent trigger-free constraint (same-owner only), unique `(shopId, lower(name))`; registry entries in `db/ownership.ts` for the new table; models and repositories in `infra/` (G-13). |
| G-30 | FR-033, FR-034, AS-35, AS-37 | `Logger.warn` interpolates the function ID and failure reason (`service.ts:170`) with no `requestId` guarantee; no metrics; errors are Nest exceptions with ad hoc strings (`:49`, `:65-66`, `:73`). | Structured logs through the platform logger with no source or payload; metrics of AS-35; problem+json codes of FR-034 through the global filter (no `BadRequestException` strings). |
| G-31 | VII.2 to VII.4 | Tests do not use HTTP, mock the queue, import tenancy's model and use `KEYS`; no tests for validation, 401/403/404, concurrency, idempotency, DLQ, rate limit, rollback, entitlement, budgets or breaker half-open. | Implement every row of `test-plan.md` (39 scenarios, four e2e files, four unit specs, one ops check). |

## 2. Open debt-register rows touching this capability

`docs/architecture/debt-register.md` has no open row that names `shop-functions` or S45 explicitly. The generic open rows apply to this domain as follows:

| Row | Rule | What applies here | Replaced by |
|---|---|---|---|
| D-6 | I.2 | `application/shop-functions.service.ts` injects the Sequelize connection and Redis and writes raw SQL (`:38-42`, `:53`, `:67`, `:81`, `:86`, `:100-107`, `:150`); `api` (the controller lives inside `shop-functions.module.ts:21-37`) imports `application/` and DTO classes from the module file; no `domain/` ports. | Controller in `api/`, DTOs in `api/`, use-case services in `application/`, repository and cache/breaker ports in `domain/` with adapters in `infra/` (all G-xx above). |
| D-7 | IX.4 | No `*Model` of another domain is imported in production code. The e2e spec imports tenancy's `ShopModel` (`shop-functions.e2e-spec.ts:11`, test code). The orders port import (G-01) is the only foreign edge. | Test: seed shops through the shared seeds, no model import. Production: **R1** only — `DiscountEvaluationService` (provided to orders), `EntitlementsService` (required from billing), `ShopScoped` (required from tenancy). |
| D-8 | X.4 | The barrel exports two Nest modules only; fine. After the change it exports `ShopFunctionsModule`, `FunctionJudgeModule`, `DiscountEvaluationService` and the two DTO types, nothing from `infra/`. | Keep it that way (AS-38). |
| D-12 | IX.4 | Raw SQL in this domain touches only `ShopFunction`, `ShopFunctionVersion`, `ShopFunctionTestCase` (all owned, `db/ownership.ts:154-156`): no cross-domain SQL today. The migration's FK to `"Shop"` is the only cross-owner reference (G-29). | Drop the FK; the shop ID becomes a plain column; shop existence is guaranteed by S03's `ShopScoped` at the route and not needed at checkout. |
| D-11, D-15, D-17 | X.5 | Not touching this domain, but G-01 is the same kind of edge (shop-functions → orders) and must not be added to the strongly connected component of D-15. | R1 export in the direction orders → shop-functions only. |

## 3. `check:table-ownership` lines for `shop-functions`

Not run (see the note at the top). Expected from reading the code: **MODEL** rows: none in production code; **SQL** rows: none against another owner; **reference** rows: the FK `ShopFunction → "Shop"` in `migrations/20261002150000-shop-functions.js:9` (tenancy-owned). The implementation agent runs `pnpm --dir packages/backend check:table-ownership` before starting and after each step; the target for this domain is zero rows, reached through:

| Finding | Mechanism that replaces it |
|---|---|
| FK to `"Shop"` | Plain `shopId` column, no foreign key; membership and status come from **R1** (S03 `ShopScoped`) at the route; the checkout path takes shop IDs from the cart (**R1** argument from orders). |
| Orders' `CheckoutDiscounts` import (graph edge, not a table) | **R1**: orders imports `DiscountEvaluationService` from `@app/domains/shop-functions`. |
| Entitlement read (none today; required by the spec) | **R1**: `EntitlementsService.getMany('SHOP', ids)` and `hasEntitlement` from billing; no read of billing tables, no copy. |
| Seller-visible shop or product data (none) | Not needed: seller code receives only cart lines passed as call arguments; no read model (R3) is required. |

## 4. Suggested order of work

1. **Pure domain with tests** (`domain/`): version state machine (G-16), discount amount (G-02), breaker (G-07), output and input schemas (G-26, G-06).
2. **Sealed runtime** (G-24 to G-27) with the extended `sandbox.spec.ts`.
3. **Migration and registry** (G-29), repositories behind ports, history rows, constraints (G-13, G-14, G-17).
4. **Judge consumer, outbox request, recovery job, backlog gauge** (G-14, G-19 to G-22); VII.4 tests.
5. **Management routes, contracts, errors, entitlement and permission** (G-09 to G-12, G-15, G-18, G-23, G-30).
6. **Evaluation service and the orders cut-over** (G-01 to G-08) with S10; delete the orders port and the `@Global()` provider.
7. **Runner deployment and ops check** (G-28), then the static checks (AS-38) and the recorded green run of every suite (VII.9).
