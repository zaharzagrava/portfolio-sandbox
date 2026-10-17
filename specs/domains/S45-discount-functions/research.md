# Research: S45 — Seller discount functions

No `NEEDS CLARIFICATION` remains: `questions.md` defaults are accepted and none was edited by a human. Below: decisions the plan needed, the status of each `gaps.md` row against the tree, and the sibling facts checked.

## Decisions

### D-01 Layering and what orders sees
- **Decision**: `DiscountEvaluationService` (application) is the only symbol orders imports, through `@app/domains/shop-functions`; `DiscountCartDto`/`DiscountEvaluationDto` are plain exported types. `ShopFunctionsModule` loses `@Global()` and the `useExisting` provider; orders' module imports `ShopFunctionsModule` explicitly.
- **Rationale**: removes the shop-functions → orders edge (G-01, X.5) and the hidden global binding that made orders boot only inside a host that also loads this module (L-018).
- **Alternatives**: keep the abstract port in a shared lib (a third place both import; rejected, spec FR-036/037 and S10 AS-24 name the service).

### D-02 Pure rules first
- **Decision**: `discount-amount.ts`, `version-state.ts`, `breaker.ts` are pure functions taking the clock/time as a parameter; the application layer is glue. `fast-check` property for AS-26 (10,000 cases).
- **Rationale**: AS-21, AS-26, AS-29 are rule tables; proving them at unit level keeps the e2e files to wiring cases (test-plan).

### D-03 Sealed runtime lifecycle (G-24..G-27)
- **Decision**: a new `ivm.Isolate` per run (memory 32 MB), compile + run in a fresh context, **destroyed after every run** (not only after failure). The wrapper is built from a hardened prelude evaluated before the seller source: `Date`, `Math.random`, `eval`, the `Function` constructor (and `globalThis.constructor.constructor`, `Object.getPrototypeOf(async function(){}).constructor` etc.) are replaced by throwers (`not available` / `not allowed`), `import()` is a syntax error in a script (classified `compile-error`/`runtime` with the engine message), and the prelude object is frozen. Classification uses the **isolate state and error class** (`isolate.isDisposed`, `cpuTime`/timeout flag from isolated-vm, `RangeError`), never a regex on message text; the only text test left is the engine's own fixed timeout message, replaced by a wall-clock + `isolate.wallTime` comparison against the budget.
- Compile time (≤ 50 ms) is measured separately from the run budget (5 ms); both fall inside the 200 ms call deadline.
- A **pool of 4 empty isolates, single use**, absorbs creation cost in core; a semaphore of 8 bounds concurrent isolates (plan: Isolate budget). No compiled-instance cache exists, so there is nothing to key by shop (FR-023 holds by construction); the memo (D-08) is what avoids re-running.
- **Rationale**: per-run destruction is the only design that proves "no state survives a run and nothing is shared between shops" without relying on every escape being closed; its cost lands on a cold memo only.
- **Alternatives**: per-version cached isolate with a fresh context per run (rejected: a compiled instance shared across runs contradicts FR-023 literally, and a heap-level leak would cross runs); `node:vm` (explicitly not a boundary, FR-022).
- **Risk**: isolate creation latency under load. If the e2e budget test (AS-31) shows creation > ~10 ms p95 on the build machine, raise the pool size, never add a cache. Measured number goes in `quickstart.md` only if it is automated; it is not (Ops artifacts).

### D-04 Output contract (G-26)
- **Decision**: strict zod `FunctionOutput`: `lineIndex` int ≥ 0 (range against the input checked by `validateAgainstInput(output, lines)`), `type` enum, `percentage` value in `(0,100]` with ≤ 2 decimals checked on the integer `round(value*100)` equality, `fixedPerUnit` integer ≥ 1, `message` ≤ 80, ≤ 50 discounts, `.strict()` objects, serialised size ≤ 64 KiB measured on the string before `JSON.parse`; `JSON.parse` wrapped (failure = `invalid-output`). The schema refuses a percentage above 100 (FR-021). Background: spec AS-26 says "a percentage over 100 is clamped to 100" in the money step and the schema says `(0,100]`; the two are reconciled by the AS-14 table (`invalid-output` for out-of-schema values) and AS-26 (the clamp applies to values the schema admits plus the shop gross clamp). The implementation follows FR-021 for the schema (≤ 100) and keeps the clamp as a defensive second wall in `discount-amount.ts` (a pure function may be called with any validated output), proven by a unit row.
- **Alternatives**: allowing > 100 and clamping (rejected: hides seller bugs the judge should catch, questions.md BREAKING row).

### D-05 Judge placement and the runner channel (G-28)
- **Decision**: coordinator (worker app) calls the runner over a **Unix domain socket** on a volume shared by the two containers of one task/pod; newline-delimited JSON, one request per connection: `{runId, source, cases:[{name,input,expected}], caseBudgetMs, totalBudgetMs}` → `{runId, verdicts:[…]}`. The runner has `network: none`, read-only root with a `tmpfs` for the socket directory only, non-root uid, default seccomp, no environment secrets, CPU and memory limits. The coordinator validates the reply with a strict zod schema (IV.8) and treats a missing/late/invalid reply as "unavailable" (the version stays `TESTING`; the recovery job re-requests, FR-020).
- **Rationale**: a UDS needs no network namespace, so the "no outbound route" check is literally `network_mode: none`; HTTP on loopback would force a network interface into the runner.
- **Alternatives**: runner pulls from the queue (rejected: needs queue credentials and network); stdin/stdout of a spawned child in the worker (rejected: the child inherits the worker's environment and credentials unless carefully stripped, and the container wall is the point).
- **Test seam**: e2e boots the runner **in-process on a temp socket** (same code, `runner/main.ts` exports `startRunnerServer(path)`); the container hardening is proved by the static `check:function-runner` (AS-23), the live container probe is an Ops artifact.

### D-06 Version numbering, limits, concurrency (G-12, G-14)
- **Decision**: `submit` runs in one transaction: `SELECT … FROM "ShopFunction" WHERE id=:id AND "shopId"=:shopId FOR UPDATE` (serialises submissions of one function, gives 404 for a foreign function), then `max(version)+1` with the cap check (`version_limit_reached` at 100), insert version, freeze the suite as version-keyed test-case rows (`INSERT … SELECT` from the current suite), insert history `∅ → QUEUED`, `outbox.appendTask`. Function creation takes `pg_advisory_xact_lock(hashtext('shopfn:'||shopId))` before the count and the insert (3 per shop, AS-03).
- **Rationale**: row lock, not retry, so the 10-way `Promise.all` of AS-12 yields 4..13 with no PK violation.

### D-07 One `ACTIVE`, `activeVersion` consistency, no cross-owner FK (G-17, G-29)
- **Decision**: partial unique index `ON "ShopFunctionVersion"("functionId") WHERE status='ACTIVE'`; the pointer is held by a **constraint, no trigger**: `ShopFunction` gets a stored generated column `activeStatus` (`'ACTIVE'` when `activeVersion` is not null, else null) and a composite foreign key `("id","activeVersion","activeStatus") → ("functionId","version","status")` on a unique index of those three columns, `DEFERRABLE INITIALLY DEFERRED` (MATCH SIMPLE: a null `activeVersion` is not checked). SQL that points `activeVersion` at a `REJECTED` version is refused at commit, and a status change away from `ACTIVE` while the pointer still names the version is refused too, so the code path demotes and re-points inside one transaction. The FK and the partial index are same-owner (IX.4).
- Drop `ShopFunction.shopId → "Shop"` (IX.4).
- **Alternatives**: trigger (rejected by gaps: "trigger-free").

### D-08 Evaluation: cache, memo, breaker (G-03, G-07, G-08)
- **Decision**:
  - Active set: Redis `shopfn:active:{shopId}` JSON, TTL 60 s; cache-aside; corrupt entry = miss (zod parse); one SQL for all missing shops (`WHERE "shopId" = ANY(:ids)`); dropped **after commit** on activate, rollback, enable, disable, delete (and judge activation).
  - Memo: `shopfn:memo:{functionId}:{version}:{sha256(canonical input)}` → integer amounts per line (the validated, **pre-shop-clamp** per-line discount vector), TTL 60 s; failures never written. Keyed by version, so a new version, rollback or delete never reads an older entry.
  - Breaker: Redis hash `shopfn:breaker:{functionId}` operated by Lua scripts: `recordFailure` does `INCR` + `EXPIRE` (60 s) atomically, opens at 5 (sets `openUntil = now+300`), `admit` returns `ADMIT | SKIP | TRIAL`; `TRIAL` is granted to exactly one caller by `SET … NX PX` after `openUntil` has passed; success closes, failure re-opens. State transitions mirror `domain/breaker.ts` (the unit spec is the table; the Lua is tested through the e2e with frozen time and 20 concurrent calls). The injected clock supplies `now` as an argument (Lua never reads the server clock) so frozen-time tests work.
  - Everything Redis is wrapped: a Redis error is a cache miss, an error from the breaker store admits the call (the 5 ms budget bounds the cost; logged at most once a minute); a memo write failure is ignored.
- **Rationale**: shared across instances (AS-29), atomic (G-07), tolerant (AS-33 cache lost).

### D-09 Evaluation algorithm and deadline (G-03, G-04)
- **Decision**: validate cart (≤ 50 lines, ≤ 10 shops, shop IDs present, currency regex, integers) → `invalid_cart` empty result; entitlements `getMany('SHOP', shopIds)` once (rejection ⇒ every shop `entitlement_unavailable`); load the active sets in one batch; `Promise.all` over shops each running its functions sequentially in `(name, id)` order; an overall `AbortController`-style deadline of 200 ms (`Promise.race` against a timer from the injected clock's scheduler); shops finished before it are summed, unfinished ones count `budget_exceeded`. The public method is `try { … } catch { return empty }`, so it never rejects (FR-026). Per shop, per-line best discount across functions (`max`), then shop clamp to gross; only `> 0` returned.

### D-10 Judge state machine and idempotence (G-16, G-17, G-20, G-21)
- **Decision**: the claim is `UPDATE … SET status='TESTING' WHERE status='QUEUED'` asserting one row, with a history row `QUEUED → TESTING`. A delivery that finds the version already `TESTING` judges it again (AS-17, crashed worker) and writes no history row (no status change). Result application is one transaction: `TESTING → ACTIVE | SUPERSEDED(stale) | REJECTED` with `WHERE status='TESTING'` asserting 1 row; zero rows = another delivery won, ack and do nothing. `judgeAttempts` counts judge requests: the submit counts 1 and the recovery job adds 1 per re-request (not per redelivery), so "5 attempts in total" of AS-19 is exact.
- Stale rule: pass and `version > coalesce(activeVersion, 0)` → `ACTIVE` (demote previous in the same transaction); else `SUPERSEDED reason=stale`.
- Rollback: `SELECT … FOR UPDATE` on the function row, conditional update of target `SUPERSEDED(passed)`, demote current `ACTIVE`, set pointer; two concurrent identical requests: the second sees the target already `ACTIVE` → `409 version_not_activatable`.

### D-11 Observability (G-22, G-30)
- **Decision**: metrics registered once in `shop-functions.metrics.ts` with the closed outcome/verdict label sets of AS-35; histogram `shop_functions_evaluation_duration_ms`; backlog gauges set by a job-driven refresh (every 15 s inside the recovery job tick, plus a read-time recompute in a scrape callback if the registry supports collect hooks): two queries, `count(*) FILTER (WHERE status='QUEUED')` and `min(createdAt)` of `QUEUED`. Logs never receive source, input or message; log fields are `functionVersionHash` (the first 12 chars of `sourceHash`) and `requestId`/`traceId`.

### D-12 Permission before S03 adds `functions.manage` (G-09)
- **Finding**: `tenancy/domain/permissions.ts` has no `functions.manage`. The spec Assumptions say "until then, `shop.manage` has the same role set" (ADMIN has it, OWNER has all).
- **Decision**: one exported constant `FUNCTIONS_PERMISSION = 'shop.manage'` in `api/`; when S03 ships the new permission the change is one line. Listed under Sibling-spec follow-ups (S03). The AS-04 role table passes today because `shop.manage` is in `SENSITIVE_PERMISSIONS` (read from the database, not cache), which is stricter and acceptable.

### D-13 Entitlement key before S18 adds `shopFunctions` (G-05, G-09)
- **Finding**: `EntitlementKey` in billing does not include `shopFunctions` (`assertEntitlementKey` would throw `unknown_entitlement`).
- **Decision**: the domain depends on a port `ShopFunctionsEntitlements` (`getMany(shopIds) → Map<shopId, boolean>`, `has(shopId) → boolean`) whose default adapter (`infra/billing-entitlements.adapter.ts`) calls S18's `EntitlementsService` with the key `shopFunctions` and treats `unknown_entitlement` as **not entitled** (fail closed, logged once). Tests bind a billing test double that grants the key, as the spec Assumptions allow. The route guard uses `RequiresShopEntitlement('shopFunctions')` once S18's allowlist has the key; until then the guard cannot be applied without failing every request, so the management routes call the port in the service (`403 entitlement_required {feature}`) and the guard swap is one line, listed under Sibling-spec follow-ups (S18).
- **Risk**: with the production adapter and no S18 key, nobody is entitled, so the feature is off in production until S18 adopts it. This is the safe direction (fail closed) and is stated in `gaps.md`.

### D-14 Contracts, DTO validation and errors (G-10, G-11, G-30)
- **Decision**: request DTOs are class-validator classes with nested `@ValidateNested` + `@Type`, closed by the global pipe (`whitelist`, `forbidNonWhitelisted`); the **expected output** and the input are additionally validated by the same zod schemas the sandbox uses (`invalid_test_case`, naming the test and field). Body limits: 256 KiB on the tests routes through `jsonBodyLimits` from `@app/infrastructure/platform`. Typed domain errors carry the FR-034 `code`; the global filter renders problem+json. Response DTOs are built by mappers; contract schemas live in `packages/contracts/src/shop-functions/` and are parsed in every e2e assertion (VII.6).

### D-15 Migration of existing rows
- **Decision**: existing `ShopFunctionTestCase` rows (no `version`) become the current suite (`version IS NULL`); existing versions get a history row `∅ → <status>` at migration time and `judgedAt = createdAt` for judged ones; old test cases that use `unitPrice` are rewritten to `unitPriceMinor` in `input` by the migration's data step (JSONB path update), and stored sources that read `unitPrice` stay as-is but will fail their next judge, which is the `[BREAKING]` row of `questions.md` (documented, not silently repaired). `ShopFunction.updatedAt` backfilled to `createdAt`.

## Gap status (read against the tree on 2026-10-17)

| Gap | Status | Plan reference |
|---|---|---|
| G-01 | open: `service.ts:8,34`, `module.ts:25,43,46` still import orders | D-01, orders cut-over |
| G-02 .. G-08 | open: only the sandbox call is fail-safe; unit prices, no entitlement, no budget, non-atomic breaker | D-08, D-09 |
| G-09 .. G-15 | open: two routes only, `shop.manage`, untyped tests array | D-12, D-13, D-14, D-06 |
| G-16 .. G-23 | open: bare `UPDATE`s, no history, no recovery, no gauge | D-10, D-11 |
| G-24 .. G-27 | open: isolate cached by source hash, `Date`/`Math.random` available, regex classification | D-03, D-04 |
| G-28 | open: no runner app, no check | D-05 |
| G-29 | open: FK to `"Shop"` in `migrations/20261002150000-shop-functions.js:9`; `ShopFunctionVersionHistory` missing | D-07, D-15 |
| G-30 | open | D-11, D-14 |
| G-31 | open: 3 service-level tests | test-plan |
| Section 3 (`check:table-ownership`) | not run by this planning pass (needs a run outside the unattended agent's approval); the implementation's first task runs it and records the live rows | tasks |

## Sibling facts checked (read, not assumed)

- S49: `declareJobType`, `JobsService.upsertSchedule`, `InvalidScheduleError` exist; pattern in `content/application/story.job-types.ts` and `seller-insights/infra/crawler.worker.ts`.
- S50: `definePolicies(owner, {…})` + `PolicyNameRegistry` augmentation (`seller-insights/api/rate-limit-policies.ts`).
- S53: `OutboxService` append in the caller's transaction (`libs/infrastructure/outbox`); `AppendTask` variant exists (`outbox-tasks.e2e-spec.ts`).
- S10: orders still ships `LegacyCheckoutDiscountsAdapter` (`orders/infra/discounts.adapter.ts`) over the optional `CheckoutDiscounts`; `orders-boundary.e2e-spec.ts` pins the transitional export list.
- S03: no `functions.manage` (D-12). S18: no `shopFunctions` key (D-13).
