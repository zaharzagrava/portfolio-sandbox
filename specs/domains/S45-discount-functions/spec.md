# Feature Specification: S45 — Seller discount functions (domain `shop-functions`)

**Feature Directory**: `specs/domains/S45-discount-functions`
**Created**: 2026-10-06
**Status**: Draft
**Input**: Capability S45 of `scripts/sdd/capabilities.tsv`: "Seller discount functions: submission, sandboxed judge with test cases, versions, fail-safe evaluation at checkout". Sources: `docs/showcase/sections/SD-40-shop-functions-sandbox.md`, `interview-prep/10-system-design/09-data-and-infrastructure.md` design 40 (online judge: queued submissions, an isolated runner with no network, a read-only file system, CPU/memory/time limits, run against test cases, verdicts back to the client; autoscale runners on queue depth; pre-warmed pools). Pattern-map rows for S45: **P0112** (runtime validation at boundaries), **P0510** (untrusted code isolation: `vm` is not a sandbox), **P0620** (fallbacks and graceful degradation, tested). Domain map: `shop-functions` owns `ShopFunction`, `ShopFunctionVersion`, `ShopFunctionTestCase`, exports `evaluateDiscounts(cart)` (R1) consumed by orders, depends on billing (R1 entitlement). Constitution v3.1.0 (III, IV, V, VII, VIII, IX, X).

## Overview

A professional shop can write a **small JavaScript function** that decides a discount for its own cart lines: "buy 3 cases, take 200 off each", "15% off when you buy 3 or more". This is **untrusted code written by a seller and run on our servers**, so the whole capability is built around three promises.

- **The seller's code can never hurt us or anyone else.** It runs in a sealed runtime with no network, no files, no clock, no randomness, no access to other shops or to customer data, a hard memory cap and a hard time limit. A function that loops forever, eats memory, crashes or returns nonsense is stopped and its result thrown away.
- **Nothing reaches checkout unproven.** A seller submits a version of the function together with test cases (an input cart and the exact discounts expected). A judge runs every case in the sealed runtime. Only a version that passes **every** case becomes the active version; a failing version is rejected with a verdict per case, and the previously active version keeps serving.
- **Checkout never breaks and never overcharges because of seller code.** At checkout each shop's active functions get 5 ms each. If a function times out, crashes, returns something invalid, belongs to a shop without the paid entitlement, or has failed too often recently (breaker open), it simply contributes **no discount** and the buyer pays the catalogue price. The checkout always answers.

The money contract with checkout is small and exact: checkout sends the cart, we answer with **one integer discount amount per shop** (minor units, never more than that shop's gross). How the amount is split over lines is checkout's concern (S10).

### Scope

In scope: seller management of functions (create, list, read, delete, enable and disable) and of their test suites; version submission, the asynchronous judge with per-case verdicts, the version state machine (QUEUED → TESTING → ACTIVE, REJECTED or SUPERSEDED), rollback to an earlier passing version; the sealed runtime and its limits; the exported discount evaluation used by checkout (time budgets, memoization, circuit breaker per function, entitlement check, fail-safe); the judge's operational surface (recovery of stuck versions, backlog gauge, hardened runner deployment); observability.

Out of scope (owners named):

- Cart, order, price recomputation, allocation of a shop discount over lines, the 250 ms checkout-side timeout, flash-sale lines (never sent to us) → **S10 / S11** (`orders`).
- Who may do what in a shop and the shop status gate → **S03** (this capability uses a new permission `functions.manage` that S03 is asked to define).
- Plans, entitlements and their cache → **S18** (`billing`); this capability asks for a boolean entitlement `shopFunctions`.
- Outbox relay, consumer framework (validation, DLQ, idempotency), jobs with single-run leases, rate-limit engine, problem+json filter, clock, config, metrics, logging → **S53 / S49 / S50 / S54**.
- A browser editor for functions. No web capability lists one (W04 covers API keys and webhooks only). This capability delivers the API such an editor would call; the UI journey column of the test plan is therefore empty.
- Any other kind of seller function (shipping, payment customisation, validation), coupons and codes, tax, discounts that depend on the buyer, previous orders or time of day (the runtime has no clock; see Assumptions).

Cross-domain data used (constitution IX.7): shop **entitlement** by **R1** (S18 `EntitlementsService`, batch `getMany` at checkout, `hasEntitlement` on management routes); shop membership and permission by **R1** through S03's `ShopScoped` guard. Cart lines arrive as **R1 call arguments** from orders (no read of orders' tables). This capability reads and writes only its own tables, holds no copy of shop or product data, and has no foreign key to any other domain's table.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A seller creates a function and its test suite (Priority: P1)

A shop owner or admin on a plan that includes discount functions creates a function (a name) with a suite of test cases, can change the suite later, can list and read their functions, switch a function off and on, and delete it. Every other role, shop or anonymous caller is refused.

**Why this priority**: nothing else exists without a function and a suite; the permission and tenant boundary are set here.

**Independent Test**: with an `ADMIN` session, create, read, list, change tests, disable, enable and delete a function; repeat with every other role and another shop's session.

**Acceptance Scenarios**:

1. **AS-01 (create)** — **Given** an `ADMIN` of `ACTIVE` shop `S` whose plan has the entitlement `shopFunctions`, and a body `{name: "third-case-discount", tests: [{name: "3 cases", input: {currency: "EUR", lines: [{productId: "p1", category: "cases", quantity: 3, unitPriceMinor: 1200}]}, expected: {discounts: [{lineIndex: 0, type: "fixedPerUnit", value: 200, message: "3rd case off"}]}}, {name: "2 cases", input: {currency: "EUR", lines: [{productId: "p1", category: "cases", quantity: 2, unitPriceMinor: 1200}]}, expected: {discounts: []}}]}`, **When** `POST /api/shops/S/functions`, **Then** `201` with `{id, shopId: S, name, enabled: true, activeVersion: null, latestVersion: null, testCount: 2, breaker: {state: "CLOSED", openUntil: null, lastFailure: null}, createdAt, updatedAt}` parsed by `shopFunctionSchema`; exactly one function row (`shopId: S`, `enabled: true`) and two test-case rows (the current suite) exist; no version exists; no judge task exists.
2. **AS-02 (validation)** — **Given** a manager, **When** the create body has: no `name`, an empty or whitespace-only name, a name over 60 characters, no `tests`, an empty `tests`, more than 50 tests, a test without `name` or with a name over 80 characters, an `input.lines` that is empty or has more than 50 lines, a line with a non-integer, negative or zero `quantity`, a `quantity` over 1,000, a non-integer or negative `unitPriceMinor` or one over 1,000,000,000, a `currency` that is not three uppercase letters, an unknown property anywhere, or a body over 256 KiB, **Then** each answers `400 validation_failed` with the offending field named in `errors[]` and nothing is stored; **When** two tests share a name, **Then** `422 invalid_test_case` with `detail` naming the duplicate; **When** a test's `expected` is not a valid function output (see FR-021: unknown `type`, non-positive `value`, `lineIndex` outside `input.lines`, more than 50 discounts, a `message` over 80 characters), **Then** `422 invalid_test_case` naming the test and the field, nothing stored.
3. **AS-03 (limits and unique name, concurrent)** — **Given** shop `S` with 2 functions, **When** 5 `POST /functions` requests with distinct names run at the same time (`Promise.all`), **Then** exactly one answers `201`, the other four answer `422 function_limit_reached`, and `S` has exactly 3 functions; **When** a function named `Third-Case-Discount` is created while `third-case-discount` exists in `S`, **Then** `409 function_name_taken` (names are unique per shop, case-insensitive) and the same name in another shop is accepted.
4. **AS-04 (permission, tenant, authentication)** — **Given** users `OWNER`, `ADMIN`, `STAFF`, `VIEWER` of shop `A`, a member of shop `B` only, and an anonymous caller, and function `F` of `A`, **When** each calls every route of this capability (create, list, read, delete, enable, disable, tests read and replace, version submit, list, read and activate), **Then** `OWNER` and `ADMIN` succeed, `STAFF` and `VIEWER` get `403 forbidden`, the member of `B` gets `404` on `A`'s routes, the anonymous caller gets `401`; **When** a manager of `B` calls `GET /api/shops/B/functions/F` (a function of shop `A` under their own shop), **Then** `404 function_not_found` with the same body as for an ID that does not exist; no route ever returns another shop's function, version, source or verdicts.
5. **AS-05 (entitlement on write routes)** — **Given** an `ADMIN` of shop `S` whose plan lacks `shopFunctions`, **When** they call create, tests replace, version submit, enable or activate, **Then** each answers `403 entitlement_required {feature: "shopFunctions"}` and nothing is stored; **When** the same admin calls the read routes, disable or delete, **Then** they succeed (a seller who downgraded can still see, switch off and remove what they have).
6. **AS-06 (replace the test suite)** — **Given** function `F` with a suite of 2 cases and versions 1 (`ACTIVE`) and 2 (`REJECTED`), **When** `PUT /api/shops/S/functions/F/tests {tests: [3 cases]}`, **Then** `200 {tests: [3 cases]}` (same validation as AS-02), the current suite has exactly the 3 new cases, versions 1 and 2 keep the cases frozen at their submission (AS-22), no version changes status and no judge task is created; **When** the body is empty, **Then** `400`.
7. **AS-07 (list and read)** — **Given** shop `S` with 3 functions and shop `T` with 1, **When** `GET /api/shops/S/functions?limit=2`, **Then** `200 {items: [≤2 shopFunctionSchema], nextCursor}` ordered by `createdAt` descending then `id` descending with an opaque cursor, and following the cursor returns the rest with no duplicate and no gap; `limit` over 50 is `400`; a tampered cursor is `400 invalid_cursor`; **When** `GET …/functions/F` after a function failure at checkout, **Then** `breaker.lastFailure` is `{reason, at}`.
8. **AS-08 (delete)** — **Given** function `F` with an active version, warm evaluation caches, one version in `TESTING` and judge tasks pending, **When** `DELETE /api/shops/S/functions/F`, **Then** `204`, the function, its versions, history and test cases are gone, the very next `evaluateDiscounts` for `S` applies nothing from `F` (on every instance), a later judge delivery for `F` ends with no effect and no error, and deleting again answers `404 function_not_found`.
9. **AS-09 (enable and disable)** — **Given** an enabled function with an active version, **When** `POST …/F/disable`, **Then** `200` with `enabled: false`, the very next `evaluateDiscounts` applies nothing from `F`, and the active version stays `ACTIVE`; **When** `disable` is called again, **Then** `409 function_state_conflict` and nothing changes; **When** `POST …/F/enable`, **Then** `200` with `enabled: true` and the next evaluation applies `F` again; **When** `enable` is called on an enabled function, **Then** `409 function_state_conflict`.

---

### User Story 2 — A seller submits code and the judge decides (Priority: P1)

The seller submits a version of the source. It is queued, a judge runs it against the frozen test suite in the sealed runtime, and the seller reads per-case verdicts. Only an all-pass version becomes active; failing code never replaces working code. The seller can roll back to an earlier passing version.

**Why this priority**: this is the safety gate; no seller code may run at checkout without passing it.

**Independent Test**: submit a good version and watch it become `ACTIVE`; submit an infinite loop and a `require('fs')` version and see `REJECTED` with verdicts while the good version stays active.

**Acceptance Scenarios**:

1. **AS-10 (submit, judge, activate)** — **Given** function `F` with the suite of AS-01 and no versions, **When** an `ADMIN` posts `POST …/F/versions {source: "function run(input) { return { discounts: input.lines.filter(l => l.quantity >= 3).map(l => ({ lineIndex: input.lines.indexOf(l), type: 'fixedPerUnit', value: 200, message: '3rd case off' })) }; }"}`, **Then** `202 {functionId, version: 1, status: "QUEUED", createdAt}`; in the same transaction one version row (`QUEUED`, `sourceHash` = SHA-256 of the source, `createdBy` = the admin), two frozen test-case rows for version 1, one history row (`∅ → QUEUED`) and exactly one judge request in the outbox are written; **When** the judge task is delivered, **Then** version 1 passes through `TESTING` to `ACTIVE` with `verdicts: [{case: "2 cases", verdict: "pass", ms}, {case: "3 cases", verdict: "pass", ms}]` (ordered by case name), `ShopFunction.activeVersion = 1`, history rows `QUEUED → TESTING`, `TESTING → ACTIVE`, the active-set cache of shop `S` was dropped after commit, and `GET …/versions/1` returns all of it parsed by `shopFunctionVersionSchema` with `source` and `timeline`.
2. **AS-11 (submit validation, limits, rate limit)** — **Given** a manager, **When** the body has no `source`, an empty source, a non-string source, a source over 20,000 characters or an unknown property, **Then** `400 validation_failed` and nothing is stored; **Given** a function with 100 versions, **When** one more is submitted, **Then** `422 version_limit_reached`; **Given** shop `S` submitted 10 versions in the last hour, **When** an 11th is submitted, **Then** `429` problem+json with `Retry-After` and nothing is stored; **When** the function does not exist or belongs to another shop, **Then** `404 function_not_found`; a source that is syntactically wrong or has no `run` function is **accepted** (`202`) and judged (AS-14).
3. **AS-12 (concurrent submissions)** — **Given** function `F` at version 3, **When** 10 submissions run at once (`Promise.all`), **Then** all ten answer `202` with distinct versions 4 to 13 (no gap, no duplicate), ten `QUEUED` rows, ten judge requests, and `F` still has exactly one active version.
4. **AS-13 (rejection over the API)** — **Given** `F` with active version 1 and the suite of AS-01, **When** version 2 `function run() { while (true) {} }` is submitted and judged, **Then** version 2 is `REJECTED` with verdicts `timeout` for both cases (each `ms` ≤ 500 and the whole judge ≤ 2 s), `activeVersion` is still 1 and version 1 is still `ACTIVE`; **When** version 3 `function run() { require('fs').readFileSync('/etc/passwd'); return { discounts: [] }; }` is judged, **Then** `REJECTED` with verdict `runtime` and `detail` matching `require is not defined`; **When** version 4 returns `{ discounts: [] }` for the 3-case input, **Then** `REJECTED` with verdicts `wrong-output` for `3 cases` (with `actual`) and `pass` for `2 cases`; in every case the rejection is a history row `TESTING → REJECTED`.
5. **AS-14 (sandbox containment, pure rules over real sealed runtimes)** — **Given** the sealed runtime and the input of AS-01, **When** each source below is run with a 50 ms budget, **Then** the outcome matches:

   | Source does | Outcome |
   |---|---|
   | valid discount function | `ok`, output validated |
   | infinite loop | `timeout` within the budget plus 200 ms of overhead |
   | allocates memory without end | `memory`; only that runtime is destroyed, the next run in the same process works |
   | uses `require`, `process`, `fetch`, `setTimeout`, `import()`, `eval`, `Function(...)` constructor, `globalThis.constructor` escapes | `runtime` with "not defined" or "not allowed"; no host object is reachable |
   | calls `Date.now()`, `new Date()` or `Math.random()` | `runtime` "not available" (functions must be pure; see Assumptions) |
   | has a syntax error | `compile-error` with the engine message |
   | defines no `run` function, or `run` is not callable | `entry-missing` |
   | returns an unknown `type`, a negative or zero `value`, a non-integer `lineIndex`, more than 50 discounts, a `message` over 80 characters, or a non-object | `invalid-output` naming the first violation |
   | returns a result that serialises over 64 KiB | `invalid-output` |
   | sets `globalThis.x = 1` in one run | the next run (same source) sees no `x`, and a second shop's run of the identical source sees no `x` (no state survives a run and no runtime is shared between shops) |

6. **AS-15 (out-of-order judging)** — **Given** active version 1 and queued versions 2 and 3 that both pass, **When** version 3 is judged first, then version 2, **Then** version 3 becomes `ACTIVE` (version 1 `SUPERSEDED`); version 2 ends `SUPERSEDED` with its all-`pass` verdicts (a passing version older than the active one never replaces it) and `activeVersion` stays 3; history shows `TESTING → SUPERSEDED` with reason `stale`.
7. **AS-16 (one active version, concurrent)** — **Given** versions 2 and 3 both `TESTING` and both passing, **When** both complete at the same instant (`Promise.all`), **Then** exactly one version is `ACTIVE` (version 3), the other is `SUPERSEDED`, `activeVersion` equals the active version, and the database refuses a second `ACTIVE` row for the same function.
8. **AS-17 (duplicate and crashed deliveries)** — **Given** a judge task for version 2, **When** it is delivered twice (sequentially and concurrently), **Then** the second delivery changes nothing (one verdict set, one `TESTING → ACTIVE` history row, one cache drop) and both acknowledge; **Given** a worker that crashed after `QUEUED → TESTING`, **When** the task is redelivered, **Then** the version is judged again from `TESTING` and finishes with exactly one terminal history row; **Given** a delivery for a version already in a terminal state (`ACTIVE`, `REJECTED`, `SUPERSEDED`), **Then** it is acknowledged and changes nothing.
9. **AS-18 (invalid judge payload)** — **Given** judge messages with a missing `functionId`, a non-UUID `functionId`, a missing or non-positive `version`, an unknown field or non-JSON, **When** delivered, **Then** each is rejected to the dead-letter queue, no version changes, no history row is written and the consumer keeps running; **Given** a payload for a function or version that does not exist, **Then** it is acknowledged with no effect.
10. **AS-19 (stuck versions are recovered)** — **Given** a version `QUEUED` for 3 minutes whose judge request was lost, **When** the recovery job runs (every 60 s), **Then** exactly one new judge request is emitted for it and its `judgeAttempts` is incremented; **Given** a version `TESTING` for 3 minutes, **Then** the same; **Given** a version that already has 5 attempts, **Then** it becomes `REJECTED` with `rejectionReason: "judge_unavailable"` and a history row, and no further request is emitted; **Given** two job runners start the job at once, **Then** each stuck version gets exactly one request (single-run lease); versions younger than 2 minutes are untouched.
11. **AS-20 (rollback and illegal transitions)** — **Given** `F` with version 3 `ACTIVE`, version 2 `SUPERSEDED` (passed), version 1 `SUPERSEDED`, version 4 `REJECTED`, version 5 `QUEUED`, **When** `POST …/F/versions/2/activate`, **Then** `200` with version 2 `ACTIVE`, version 3 `SUPERSEDED`, `activeVersion = 2`, history rows with `actor` = the caller, the cache dropped, and the next evaluation uses version 2; **When** the target is version 4 (`REJECTED`), 5 (`QUEUED`), the already `ACTIVE` version, or a version that does not exist, **Then** `409 version_not_activatable` (`404 version_not_found` for the missing one) and nothing changes; **When** the same activate request is sent twice at once (`Promise.all`), **Then** exactly one answers `200` and the other `409`, and exactly one version is `ACTIVE`.
12. **AS-21 (version state machine, pure)** — **Given** the transition rule, **When** it is given every `(from, event)` pair, **Then** only these succeed: `QUEUED + claim → TESTING`; `TESTING + passed(newer than active or none) → ACTIVE`; `TESTING + passed(older than active) → SUPERSEDED`; `TESTING + failed → REJECTED`; `QUEUED | TESTING + attempts exhausted → REJECTED`; `ACTIVE + newer activated → SUPERSEDED`; `SUPERSEDED(passed) + rollback → ACTIVE`; every other pair is refused, including any move out of `REJECTED`, `ACTIVE + rollback`, and `QUEUED + rollback`; an unknown status fails an exhaustive check.
13. **AS-22 (the suite is frozen per version)** — **Given** function `F` whose suite is `{A, B}`, **When** version 1 is submitted, then the suite is replaced by `{A, C}`, then version 2 is submitted, **Then** version 1 is judged against `{A, B}` and version 2 against `{A, C}` regardless of when each judge runs; a later `PUT …/tests` never changes the verdicts, test count or status of an existing version.
14. **AS-23 (the judge runs sealed, operations)** — **Given** the deploy artifacts of the judge runner, **When** the ops check runs, **Then** it proves: no outbound network route, a read-only root file system, a non-root user, the default seccomp profile, no database, queue or cache credentials in the runner's environment, CPU and memory limits set, and that the runner receives source and inputs only from, and returns verdicts only to, the judge coordinator over a local channel.

---

### User Story 3 — Checkout applies discounts and never breaks (Priority: P1)

At checkout, orders asks for the discounts of every shop in the cart in one call. Each shop's enabled, entitled functions run on that shop's lines only; the answer is one integer amount per shop. Anything that goes wrong costs the buyer nothing and the seller only their own discount.

**Why this priority**: this is the business value and the safety promise (P0620).

**Independent Test**: with an active function, call `evaluateDiscounts` for a two-shop cart and see exactly the first shop's discount; then break the function in each way and see the checkout answer with no discount.

**Acceptance Scenarios**:

1. **AS-24 (happy path)** — **Given** shop `S1` with an active, enabled function (AS-10's source) on a plan with `shopFunctions`, shop `S2` with none, and the cart `{currency: "EUR", lines: [{productId: a, shopId: S1, category: "cases", quantity: 3, unitPriceMinor: 1200}, {productId: b, shopId: S1, category: "bottles", quantity: 1, unitPriceMinor: 500}, {productId: c, shopId: S2, category: "cases", quantity: 3, unitPriceMinor: 1200}]}`, **When** `evaluateDiscounts(cart)` is called, **Then** it resolves `{shopDiscounts: [{shopId: S1, discountMinor: 600}]}` (3 units × 200; `S2` is absent because it has nothing), nothing is written to any table, and one outcome `applied` is counted for the function.
2. **AS-25 (a function sees only its own shop, and no personal data)** — **Given** a function of `S1` that returns a fixed discount of `lines.length × 100` per unit on line 0 and a cart with 2 lines of `S1` and 3 lines of `S2`, **When** evaluated, **Then** `S1`'s discount is `2 × 100 × quantity` (it saw 2 lines, not 5), its input contained exactly `{currency, lines: [{productId, category, quantity, unitPriceMinor}]}` with no shop ID, user ID, name, address, email or token, and `S2`'s functions never received an `S1` line.
3. **AS-26 (output to money, pure)** — **Given** a validated function output and the shop's lines, **When** the amount is computed, **Then** the rules hold: `fixedPerUnit` discount = `min(value, unitPriceMinor) × quantity`; `percentage` discount (value in `(0, 100]` with at most 2 decimals, held as basis points) = `floor(unitPriceMinor × quantity × basisPoints / 10,000)` in integer arithmetic; a `percentage` over 100 is clamped to 100; several discounts on one line add up and are clamped to the line's gross (`unitPriceMinor × quantity`); a `lineIndex` outside the shop's lines, a `fixedPerUnit` that is not an integer, or a `value` that is not finite make the whole output **invalid** (the function counts as failed with outcome `invalid_output`, contributes nothing); the shop total is the sum over lines, an integer, never negative and never above the shop's gross; table-driven cases include `(unit 1000, qty 3, 33.33%) → 999`, `(unit 1, qty 1, 50%) → 0`, `(unit 999, qty 1, fixed 5000) → 999`, and a property test (10,000 random lines and outputs) shows: integer, `0 ≤ discount ≤ gross`, deterministic, and monotone in `value`.
4. **AS-27 (several functions per shop)** — **Given** shop `S1` with functions `F1` (10% on line 0) and `F2` (fixed 50 per unit on line 0) both active (line 0: unit 1000, qty 2), **When** evaluated, **Then** per line the **largest** discount among the functions wins (they do not stack): line 0 gets `max(200, 100) = 200`, `S1`'s discount is 200; functions run in name order (then ID), and the result does not depend on the order; **Given** `F1` fails, **Then** `F2`'s discount still applies; the shop total stays ≤ the shop's gross.
5. **AS-28 (fail-safe, every failure class)** — **Given** shop `S1` with a function that passes its tests but fails on this cart, **When** `evaluateDiscounts` runs and the function (a) loops forever, (b) throws, (c) allocates memory without end, (d) returns an invalid output, **Then** in each case the call **resolves** with `{shopDiscounts: []}` (not a rejection), takes at most 5 ms of function time plus overhead, counts `shop_functions_evaluations_total{outcome}` with `timeout`, `runtime`, `memory` and `invalid_output` respectively, and a warning log without source or discount payload; **Given** the entitlement lookup rejects (billing unavailable), **Then** the shop gets no discount (outcome `entitlement_unavailable`); **Given** the stored definitions cannot be loaded for one shop, **Then** that shop gets no discount (outcome `definitions_unavailable`) and other shops are unaffected; **Given** a cart with a failing function in `S1` and a healthy one in `S2`, **Then** `S2`'s discount is still returned.
6. **AS-29 (circuit breaker per function)** — **Given** a function that fails at checkout, time frozen, **When** 5 failures happen within 60 s, **Then** the breaker opens: the next evaluations do **not** run the code (outcome `breaker_open`, zero executions), `GET …/F` shows `breaker: {state: "OPEN", openUntil: T+300 s, lastFailure}`, a log and `shop_functions_breaker_open_total` record the opening; **When** 300 s pass, **Then** the state is `HALF_OPEN` and exactly one evaluation (even under 20 concurrent calls) runs the code as a trial: success closes the breaker, failure opens it again for 300 s; 4 failures in 60 s followed by a success and a 61 s pause never open it; the breaker state is shared by all instances, and losing it resets to `CLOSED`.
7. **AS-30 (memoization)** — **Given** an active function and a cart, **When** the same shop lines are evaluated twice within 60 s, **Then** the code runs once and both answers are equal; **When** a line differs in quantity, price, category or product, the currency differs, or 60 s have passed, **Then** the code runs again; a failure is never memoized; a new version, rollback, disable or delete is never answered from an older version's memo (the memo is keyed by version and input).
8. **AS-31 (time budgets)** — **Given** a function that busy-waits 30 ms, **When** evaluated, **Then** it is stopped at the 5 ms budget (total function time ≤ 5 ms + 25 ms of overhead; outcome `timeout`); **Given** a cart of 10 shops × 3 functions that all busy-wait, **When** evaluated, **Then** the whole call resolves in under 200 ms (shops run in parallel, a shop's functions in sequence); **Given** an overall evaluation that would exceed 200 ms, **Then** the shops that did not finish contribute nothing (outcome `budget_exceeded`) and the completed shops' discounts are returned.
9. **AS-32 (entitlement at checkout)** — **Given** shop `S1` entitled and shop `S2` not (downgraded) with active functions in both, **When** evaluated, **Then** only `S1` gets a discount, `S2`'s functions do not run (outcome `not_entitled`), the entitlements of all shops in the cart are read in one batch call (no per-shop call), and regaining the entitlement makes `S2`'s function apply again with no resubmission.
10. **AS-33 (changes take effect, cache correctness)** — **Given** warm caches on two instances, **When** a version is activated by the judge, a rollback runs, a function is disabled, enabled or deleted, **Then** the very next evaluation on the same cache already reflects it, and no instance serves the old active set for more than 60 s; **Given** the cache is empty or lost, **Then** evaluation reads the stored definitions and still answers correctly (cache-aside, every entry has a TTL, the cache is never the source of truth).
11. **AS-34 (invalid cart input)** — **Given** a cart with no lines, a line with a non-integer, negative or non-finite price, a non-integer or non-positive quantity, a missing `shopId`, a currency that is not three uppercase letters, more than 50 lines or more than 10 shops, **When** `evaluateDiscounts` is called, **Then** it resolves `{shopDiscounts: []}`, counts outcome `invalid_cart`, runs no seller code and logs a warning without the cart body; a cart whose lines belong to no shop with functions answers `{shopDiscounts: []}` with no judge or sandbox work.

---

### User Story 4 — Operators see and trust the system (Priority: P2)

Operators can see how often seller code fails, how long the judge backlog is, and prove that no seller source or customer data leaks into logs or metrics.

**Why this priority**: untrusted code needs visible behaviour, and the judge autoscales on its backlog.

**Independent Test**: run AS-24, AS-28 and a rejected submission, then read the metrics registry and captured logs.

**Acceptance Scenarios**:

1. **AS-35 (metrics and logs)** — **Given** the runs of AS-10, AS-13, AS-24, AS-28 and AS-29, **Then** the metrics exist and are counted exactly once per event: `shop_functions_evaluations_total{outcome}` (`applied`, `no_discount`, `timeout`, `memory`, `runtime`, `invalid_output`, `breaker_open`, `not_entitled`, `entitlement_unavailable`, `definitions_unavailable`, `budget_exceeded`, `invalid_cart`), `shop_functions_evaluation_duration_ms` (histogram), `shop_functions_judge_total{verdict}` (`active`, `rejected`, `superseded`, `unavailable`), `shop_functions_breaker_open_total`; every log line is JSON with `requestId` or `traceId`; no log line, metric label or problem response contains seller source code, a test input, a discount `message`, a cookie, a token or an authorization header; labels never contain a shop ID, function ID or product ID.
2. **AS-36 (judge backlog gauge)** — **Given** 3 `QUEUED` versions of ages 10 s, 90 s and 5 s and one `TESTING` version, **When** the gauge is read, **Then** `shop_functions_judge_backlog` = 3 and `shop_functions_judge_oldest_queued_age_seconds` ≈ 90 (the autoscaling signal); with an empty queue both are 0.
3. **AS-37 (errors and contracts)** — **Given** any failing request of this capability, **Then** the response is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a machine `code` from the list in Contracts; a 5xx carries a generic `detail` with no SQL, stack or engine message; every success body parses with its `packages/contracts` schema.
4. **AS-38 (boundaries and ownership, static)** — **Given** the repository, **When** `check:boundaries` and `check:table-ownership --strict` run, **Then** this domain has zero findings: it imports no other domain except through entry points (`@app/domains/tenancy`, `@app/domains/billing`, `@app/domains/identity`), nothing in this domain imports `@app/domains/orders`, orders reaches this domain only through its entry point and `DiscountEvaluationService`, every query touches only `ShopFunction`, `ShopFunctionVersion`, `ShopFunctionVersionHistory` and `ShopFunctionTestCase`, and the entry point exports no `*Model`, repository or sandbox class.
5. **AS-39 (the store enforces the invariants)** — **Given** the migrated database, **When** SQL tries to insert two `ACTIVE` versions for one function, a status outside the allowed set, a version number that already exists, a `ShopFunction.activeVersion` that points to a version that is not `ACTIVE`, or a source over 20,000 characters, **Then** each is refused by a constraint; there is no foreign key from any table of this domain to another domain's table, and deleting a function removes its versions, history and test cases together.

### Edge Cases

- A seller submits the same source twice: two versions with the same `sourceHash`, both judged (the second may pass and become `ACTIVE`, superseding an identical version); no deduplication.
- A function with no `ACTIVE` version, or whose active version's function is disabled, contributes nothing and costs no sandbox time.
- A version activated by rollback was judged under an older suite; it is not judged again (its frozen verdicts stand).
- The seller's test expects an empty discount list: a valid, passing case (AS-01 case `2 cases`).
- A discount function that is correct but produces no discount for a cart: outcome `no_discount`, which is not a failure and does not move the breaker.
- Flash-sale lines are never sent to this capability (S10 filters them); if one arrives it is treated as an ordinary line.
- The shop is later suspended or deleted: its carts cannot be built (S10 refuses non-active shops), so its functions are never evaluated; data purge on shop deletion follows S03's lifecycle and is not triggered here (see questions).
- A judge worker is stopped during shutdown: in-flight cases finish or the task is returned unacknowledged and redelivered (AS-17).
- Clock skew between instances never matters for results: functions have no clock; breaker and memo expiry use the injected clock.

## Requirements *(mandatory)*

### Functional Requirements

**Management and tenancy**

- **FR-001**: Every route of this capability requires an authenticated principal who is a member of the shop in the path with the permission `functions.manage` (OWNER and ADMIN) that passes S03's shop status gate; other roles get `403`, non-members `404`, anonymous `401` (AS-04).
- **FR-002**: Every lookup of a function, version, test case or history row carries the shop in the predicate; a function of another shop answers `404 function_not_found`, identical to an unknown ID (AS-04, AS-08).
- **FR-003**: Routes that create or change seller code or its suite (create, tests replace, version submit, enable, activate) require the shop entitlement `shopFunctions`; otherwise `403 entitlement_required {feature: "shopFunctions"}`. Reads, disable and delete never require it (AS-05).
- **FR-004**: A function has a name (1–60 characters, unique per shop case-insensitive) and starts enabled with no version; a shop has at most 3 functions; the limits hold under concurrency (AS-01, AS-03).
- **FR-005**: A function's current test suite has 1–50 cases; a case has a name (1–80, unique in the suite), an input (currency of three uppercase letters; 1–50 lines each with `productId`, `category`, integer `quantity` 1–1,000 and integer `unitPriceMinor` 0–1,000,000,000) and an expected output that is itself a valid function output for that input; the whole suite is at most 256 KiB; unknown properties are refused (AS-02).
- **FR-006**: Replacing the suite never alters existing versions and never triggers judging (AS-06, AS-22).
- **FR-007**: Lists use keyset pagination (`createdAt` or `version` descending, unique tiebreaker, opaque cursor, `limit` ≤ 50, default 20) (AS-07).
- **FR-008**: Deleting a function removes it, its versions, history and cases in one step, drops the evaluation caches, and makes any later judge delivery for it a no-op (AS-08).
- **FR-009**: Disabling and enabling are conditional state changes; repeating one answers `409 function_state_conflict`; both take effect on the next evaluation (AS-09).

**Submission and versions**

- **FR-010**: Submitting a version accepts a source of 1–20,000 characters, assigns the next version number of the function without gaps or duplicates under concurrency, freezes the current suite for that version, records `createdBy`, and answers `202` with status `QUEUED` (AS-10, AS-12, AS-22).
- **FR-011**: The version row, its frozen cases, its history row and the judge request are committed together or not at all; the judge request leaves the service only after commit (AS-10).
- **FR-012**: Submission is rate-limited to 10 per hour per shop (`429` with `Retry-After`); a function holds at most 100 versions (AS-11).
- **FR-013**: A version's status is one of `QUEUED`, `TESTING`, `ACTIVE`, `REJECTED`, `SUPERSEDED`; transitions follow AS-21 only, each is a conditional update that asserts exactly one changed row, and each writes a history row (`from`, `to`, `at`, `actor` or system, `reason`) in the same transaction (AS-17, AS-21).
- **FR-014**: A function has at most one `ACTIVE` version, enforced by the store, and `activeVersion` always names it (AS-16, AS-39).
- **FR-015**: A version that passes every case becomes `ACTIVE` only if it is newer than the current active version; an older passing version becomes `SUPERSEDED` with reason `stale`; a version that fails any case becomes `REJECTED` and never changes the active version (AS-13, AS-15).
- **FR-016**: A seller can roll back to a `SUPERSEDED` version that has passed; any other target answers `409 version_not_activatable`; concurrent identical requests yield exactly one success (AS-20).
- **FR-017**: A seller can read any version of their function: status, source, `sourceHash`, per-case verdicts, `rejectionReason`, `judgeAttempts`, timeline; test inputs and expected outputs of other shops are never visible (AS-10).

**The judge**

- **FR-018**: The judge claims a version with a conditional update, runs every frozen case in the sealed runtime with a 50 ms budget per case and a 10 s budget for the whole version, compares the validated output to the expected output for deep equality (same discounts, same order), and stores one verdict per case: `pass`, `wrong-output`, `timeout`, `memory`, `runtime`, `invalid-output`, `compile-error` or `entry-missing`, with `detail` (≤ 300 characters) and the measured milliseconds (AS-10, AS-13, AS-14).
- **FR-019**: Judging is idempotent and at-least-once safe: duplicate, concurrent, crashed and late deliveries produce one outcome; payloads are validated and invalid ones are dead-lettered without effect (AS-17, AS-18).
- **FR-020**: A version stuck in `QUEUED` or `TESTING` for more than 2 minutes gets a new judge request each minute, at most 5 attempts in total, then `REJECTED` with `rejectionReason: "judge_unavailable"`; the job runs once per schedule across replicas (AS-19).

**The sealed runtime (P0510)**

- **FR-021**: The function contract is: `run(input)` returns `{discounts: [{lineIndex, type, value, message}]}` with `lineIndex` an integer within the input's lines, `type` one of `percentage` or `fixedPerUnit`, `value` a finite positive number (`fixedPerUnit` an integer), `message` ≤ 80 characters, at most 50 discounts; anything else is `invalid-output`. Input and output cross the boundary only as serialised data (AS-14, AS-26).
- **FR-022**: Seller code runs in a runtime that is a separate engine instance with its own memory heap capped at 32 MB, a wall-clock time limit, and **no** access to files, network, processes, timers, modules, dynamic code evaluation, the host's objects, the date or randomness; `vm`-style in-process contexts are not an acceptable boundary (AS-14).
- **FR-023**: No state survives a run, and no runtime or compiled instance is shared between two functions of different shops or between two runs; a timeout, memory failure or crash destroys that runtime (AS-14).
- **FR-024**: The judge executes seller code only in a runner that is isolated at the process level: no outbound network, read-only root file system, non-root user, default seccomp profile, no data-store credentials, CPU and memory limits; it talks only to the judge coordinator (AS-23).

**Evaluation at checkout (P0620)**

- **FR-025**: The exported evaluation accepts a cart of lines `{productId, shopId, category, quantity, unitPriceMinor}` and a currency and returns one integer amount per shop, only for shops whose amount is greater than 0, in one call and with one batch lookup of entitlements (AS-24, AS-32).
- **FR-026**: It **never rejects**: any internal failure yields no discount for the affected function, shop or the whole call, never a thrown error, never a partial or negative amount (AS-28, AS-34).
- **FR-027**: Per shop it runs only functions that are enabled, have an `ACTIVE` version, belong to an entitled shop and whose breaker admits them, on that shop's lines only, with the input of AS-25; the shop's currency is the cart's currency (AS-25, AS-32).
- **FR-028**: Each function gets 5 ms; shops run in parallel, a shop's functions in name order; the whole call is bounded to 200 ms (under S10's 250 ms) and returns what finished (AS-31).
- **FR-029**: The output is validated (FR-021) and turned into an amount by the rules of AS-26; the shop total is clamped to the shop's gross; the largest discount per line wins across functions (AS-26, AS-27).
- **FR-030**: Each function has a circuit breaker shared across instances: 5 failures (timeout, memory, runtime, invalid output) within 60 s open it for 300 s; then one trial call decides (AS-29). `no_discount` is not a failure.
- **FR-031**: Results are memoized for 60 s per function version and canonical input; failures are never memoized; the active-function set per shop is cached for at most 60 s and dropped after every change; caches are cache-aside with TTL and never the source of truth (AS-30, AS-33).
- **FR-032**: Evaluation reads entitlements by R1 (`getMany`); an unavailable or erroring lookup gives no discount for that shop (AS-28, AS-32).

**Operations and observability**

- **FR-033**: The metrics, labels and log rules of AS-35 hold; the judge backlog gauge of AS-36 is exported; seller source, test data and discount messages never appear in logs, metrics or error bodies.
- **FR-034**: Every error is problem+json with the codes `validation_failed`, `invalid_cursor`, `invalid_test_case`, `function_not_found`, `version_not_found`, `function_name_taken`, `function_limit_reached`, `version_limit_reached`, `function_state_conflict`, `version_not_activatable`, `entitlement_required`, `forbidden`, `unauthenticated`, `rate_limited` (AS-37).
- **FR-035**: All tables of this domain are listed in the ownership registry, hold no foreign key to another domain, constrain statuses and the single active version, and are migrated expand/contract (AS-38, AS-39).
- **FR-036**: The entry point exports the module(s), `DiscountEvaluationService` and the DTO types only (AS-38).
- **FR-037**: The domain depends on no other domain's tables and on no domain that depends on it (no import of orders) (AS-38).

### Key Entities *(include if feature involves data)*

- **Shop function**: a named, per-shop discount function: `shopId`, name, enabled flag, pointer to the active version, creation and update times. A shop has at most 3.
- **Function version**: one submitted source: version number, source, source hash, status, per-case verdicts, rejection reason, judge attempts, creator, times, and the frozen test cases it was judged against.
- **Version history**: append-only record of each status change: from, to, time, actor (user or system), reason.
- **Test case**: a named input cart and expected output. The function's **current suite** is the editable set; each version holds a frozen copy.
- **Verdict**: per case result with `verdict`, `detail`, `actual` (for a wrong output), `ms`.
- **Breaker state** (operational, not authoritative): per function `CLOSED` / `OPEN` / `HALF_OPEN`, open-until time, last failure; losing it resets to `CLOSED`.
- **Discount evaluation**: a transient result `{shopDiscounts: [{shopId, discountMinor}]}`; never stored.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of the failure classes of AS-14 and AS-28 (loop, memory bomb, crash, invalid output, forbidden API, missing entitlement, unavailable billing), checkout still receives an answer and no buyer is charged more than the catalogue price (0 rejections, 0 negative or above-gross amounts in the property test of AS-26).
- **SC-002**: Checkout is never delayed by seller code for more than 200 ms in the worst case (10 shops × 3 functions all timing out), and by at most 15 ms at the 95th percentile for a cart of one shop with one healthy function and a warm cache.
- **SC-003**: 0 of the escape attempts in AS-14 reach a host object, the network, the file system or another shop's data (every probe ends in `runtime`, `timeout`, `memory` or `invalid-output`).
- **SC-004**: A version is judged and its verdicts are readable within 5 seconds of submission when the judge is idle; a version never stays `QUEUED` or `TESTING` for more than 12 minutes (5 attempts at 2-minute spacing, then rejected).
- **SC-005**: 100% of rejected versions leave the previously active version serving; 0 functions ever have two `ACTIVE` versions under 20 concurrent operations.
- **SC-006**: After a seller disables or deletes a function or rolls back, the next checkout no longer applies the old behaviour on the same cache and within 60 seconds on any instance.
- **SC-007**: A broken function stops costing checkout time after at most 5 failures within a minute (the breaker), and recovers by itself after 5 minutes if fixed.
- **SC-008**: 0 occurrences of seller source, test inputs or discount messages in logs, metrics or error bodies across the scenarios of AS-35.
- **SC-009**: Every acceptance scenario AS-01 to AS-39 has exactly one row in `test-plan.md` and a green recorded run before merge.

## Assumptions

- **Plan gating**: a plan entitlement `shopFunctions` (boolean, false on the free tier, true on `pro`) is added by S18; until S18 ships it, a test double of `EntitlementsService` supplies it. Disabling does not require it.
- **Permission**: S03 defines `functions.manage` for OWNER and ADMIN; until then, `shop.manage` has the same role set.
- **Functions are pure**: the sealed runtime has no date and no randomness, so a function cannot depend on the time of day or buyer history; this keeps memoization and judging deterministic. Time-based or buyer-based discounts are out of scope.
- **Discount scope**: a function sees only its shop's lines (no buyer identity, no other shops, no order history). One amount per shop is the only output used by checkout; the per-line split is S10's.
- **Largest wins, no stacking** across a shop's functions (per line); several discounts inside one function's output do add up (clamped to the line).
- **Budgets** (configuration defaults of this spec): 5 ms per function at checkout, 50 ms per judge case, 10 s per version judge, 200 ms overall evaluation, 32 MB per runtime, 50 cases, 50 lines, 20,000 characters, 3 functions per shop, 100 versions per function, 10 submissions per hour per shop, memo 60 s, active-set cache 60 s, breaker 5 failures per 60 s then 300 s, recovery 2 minutes, 5 attempts.
- **Judge placement**: the judge coordinator (claims, persistence) runs in the worker role; seller code executes only in the hardened runner (FR-024). Checkout evaluation runs the sealed runtime in-process in the core app (the runtime itself is the wall there), as the notes specify for the pre-warmed checkout pool.
- **Delivery**: judge requests are single-consumer tasks emitted through the outbox (IV.3, IV.4) and delivered at least once; the consumer is idempotent through conditional status updates.
- **No idempotency key** on version submission: a retried submission creates another version, which is harmless (it is a draft until judged) and bounded by FR-012.
- **No push to the browser**: sellers poll `GET …/versions/N`; a realtime push is not built.
- **Shop deletion**: purging a deleted shop's functions follows S03's offboarding; not triggered by an event in this capability.
- **Money**: integer minor units throughout; the currency is the cart's.
- All other defaults are recorded one line each in `questions.md`.

## Cross-capability contracts

**Provides** (exported from the domain entry point `@app/domains/shop-functions`, names exact):

- **R1, `DiscountEvaluationService`** (consumer: **S10** `orders`; replaces the `CheckoutDiscounts` port that lives in orders today):
  - `evaluateDiscounts(cart: DiscountCartDto): Promise<DiscountEvaluationDto>` where `DiscountCartDto = { currency: string; lines: { productId: string; shopId: string; category: string; quantity: number; unitPriceMinor: number }[] }` and `DiscountEvaluationDto = { shopDiscounts: { shopId: string; discountMinor: number }[] }`.
  - Guarantees: never rejects; `discountMinor` is an integer, `0 < discountMinor ≤` the shop's gross (`Σ unitPriceMinor × quantity` of that shop's lines in the cart); only shops with a discount appear; each shop appears at most once; resolves within 200 ms; one call per checkout (batch); reads only (writes nothing); sends no personal data to seller code; never throws on invalid carts (returns the empty result). S10 keeps its own 250 ms timeout and its `orders_discount_fallback_total{reason}` counter as the second line of defence.
  - Types exported: `DiscountCartDto`, `DiscountEvaluationDto`.
- **Module classes**: `ShopFunctionsModule` (core: HTTP routes and R1 service) and `FunctionJudgeModule` (worker role: judge consumer, recovery job). Nothing else is exported: no model, repository, sandbox class, queue name or port token.
- **HTTP** under `/api`, problem+json, schemas in `packages/contracts` (`shopFunctionSchema`, `shopFunctionVersionSchema`, `shopFunctionTestSchema`, `pageSchema(...)` = `{items, nextCursor}`):
  - `POST /shops/:shopId/functions {name, tests}` → `201 shopFunctionSchema`; `GET /shops/:shopId/functions?limit&cursor` → page; `GET|DELETE /shops/:shopId/functions/:functionId` (`DELETE` → `204`); `POST …/:functionId/enable|disable` → `200 shopFunctionSchema`.
  - `GET|PUT /shops/:shopId/functions/:functionId/tests` → `{tests}`.
  - `POST /shops/:shopId/functions/:functionId/versions {source}` → `202 {functionId, version, status, createdAt}`; `GET …/versions?limit&cursor` → page of version summaries; `GET …/versions/:version` → `shopFunctionVersionSchema` `{functionId, version, status, source, sourceHash, verdicts: {case, verdict, detail?, actual?, ms}[] | null, rejectionReason: "judge_unavailable" | null, judgeAttempts, createdBy, createdAt, judgedAt | null, timeline: {status, at, actorId | null, reason | null}[]}`; `POST …/versions/:version/activate` → `200 shopFunctionVersionSchema`.
  - Error codes: those of FR-034.
- **Rate-limit policy** (declared in S50's registry): `shop-functions.submit.shop` 10 per hour per shop (fail closed).
- **Jobs and tasks** (registered with S49 and S53): periodic job `shop-functions.recover-stuck-versions` (every 60 s, concurrency 1); single-consumer task `shop-functions.judge-version` with payload `{functionId: uuid, version: positive integer}`.
- **Metrics**: names of AS-35 and AS-36.

**Requires**:

- **S03** (`tenancy`): `ShopScoped('functions.manage')` (permission to be added for OWNER and ADMIN) with member, permission and status gate; `404` for non-members.
- **S18** (`billing`): `EntitlementsService.getMany(subjectType: 'SHOP', subjectIds: string[] ≤ 500): Promise<Map<string, Entitlements>>` and `hasEntitlement('SHOP', shopId, 'shopFunctions')`, where `Entitlements.shopFunctions?: boolean` is a **new key S18 is asked to add** to its allowlist (free tier `false`, `pro` `true`); the route guard `RequiresShopEntitlement('shopFunctions')` above `ShopScoped(...)` denying with `403 entitlement_required {feature}`; rejects `entitlements_unavailable` on failure.
- **S01** (`identity`): `Firewall`, `@User()` and `AuthenticatedUser = { id, role, sessionId, amr }`.
- **S53** (events): `outbox.append(event)` inside this domain's transaction for the judge request (type `shop_functions.judge_requested`, aggregate ID = function ID, payload `{functionId, version}`), relayed to a single-consumer queue; the consumer framework (zod payload validation, DLQ, at-least-once delivery, graceful stop).
- **S49** (jobs): the periodic job above with a single-run lease.
- **S50** (rate limiter): the policy above with `Retry-After`.
- **S54** (platform toolkit): problem+json filter with `code` and `requestId`; injected clock; config validation for the budgets; metrics registry; structured logging; graceful shutdown.
- **S10** (`orders`) calls `DiscountEvaluationService.evaluateDiscounts`; it must stop importing or defining `CheckoutDiscounts` for this purpose and must not send flash-sale lines (S11).
