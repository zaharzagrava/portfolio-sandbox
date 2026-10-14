# Implementation Plan: S11 — Flash Sales (bucketed fast stock, admission, never oversell, async reconciliation) — domain `orders`

**Branch**: `S11-flash-sales` | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md` (v3.1.0). Design artifacts: [research.md](research.md), [data-model.md](data-model.md), [contracts/http.md](contracts/http.md), [contracts/services.md](contracts/services.md), [contracts/events.md](contracts/events.md), [quickstart.md](quickstart.md).

## Summary

S10 is built (`.implemented`), so the flash code is parked in `infra/flash/` + `FlashSaleLegacyModule` and S10's checkout is order-first and catalog-only. S11 replaces the parked code with a real capability inside `orders`:

- **Pure rules in `domain/`**: bucket split and draw plan, sale state machine + window, admission allowance, drift classification, claim state machine, errors, ports (closes A21, D-6).
- **Durable side** (Postgres): reshaped `FlashSale` (new statuses, `priceMinor`, `statusReason`, `version`, exclusion constraint against overlap), append-only `FlashSaleHistory`, flash indexes on `StockReservation`; expand/contract migrations.
- **Fast store** (Redis, cluster-safe): create-if-absent buckets, the draw record living in the bucket's own slot, claim / quota / admission scripts, idempotent resumable release, sweeper; every call under a 100 ms timeout, fail closed (R-03, R-04).
- **Seam into S10 (BEFORE_ORDER)**: a second port `FlashReservationPort`; five named edits in S10 services; the catalog source is unchanged (R-01).
- **Lifecycle jobs** (S49): `load`, `end`, `reconcile`, `verify` (periodic), `sweep-claims` (periodic); stock only through `ProductStockService.applyStockDelta` (`orders:flash:<saleId>:load|return`); events through the outbox in the transition transaction.
- **Public read**: anonymous view + batch route with S52 `getOrLoad` (jitter, single-flight, SWR); degrades to `remainingApprox: null`.
- **Cleanup**: delete `infra/flash/*`, `FlashSaleLegacy*Module`, the `FlashStockService` mock-Redis spec, the two flash tests in `checkout.e2e-spec.ts`, the barrel/module exports; update the k6 script.

## Follow-ups from already-built specs (each is a requirement, planned and tested here)

| From | Requirement | Where planned / proven |
|---|---|---|
| S05 | price and stock only through `ProductQueryService.getProductsByIds` and `ProductStockService.applyStockDelta` (`operationId = <service>:<aggregate-id>:<step>`, compensation is a new operation); drop `ProductModel` and `BelongsTo(Product)` in `bis-order-item.model.ts`; archived products refuse negative deltas (`unavailable`) | WP-5 (create check via `getProductsByIds`), WP-6 (`orders:flash:<id>:load` → `START_FAILED` on `insufficient_stock`; an `unavailable` failure (archived product) is also `START_FAILED(product_unavailable)`: add this reason to `statusReason`'s CHECK and `StatusReason`), `bis-order-item.model.ts` association drop is **verified** already done by S10 (task: confirm with grep, no edit if absent); AS-15 (`product_unavailable`), AS-22 |
| S10 | take over `infra/flash/` (`flash-stock.service.ts` and spec, `flash-sale.model.ts`, jobs, `POST /shops/:shopId/flash-sales`) and `FlashSaleLegacyModule`; flash sources behind the reservation seam (`reserve`, `release`, `convert`; `source`/`sourceRef`); restore the drop behaviour at checkout through the seam; delete the TRANSITIONAL exports `FlashStockService` and `FlashSaleModel` | WP-1 (delete), WP-7 (seam), WP-11 (barrel, `orders-boundary.e2e-spec.ts`); AS-01–AS-09, AS-30–AS-36, AS-43 |
| S13 | payments no longer touches `Product.quantity`; stock for payments-related flows is S10's reservation via `applyStockDelta` | nothing to build; `convert` runs after S10's payment transition (WP-7 edit 4); AS-33/AS-34 prove the paid / late-paid paths. Mention in report |
| S30 / S48 (S25/S24/S19/S21/S38 share the note) | replace the loose upstream schema for the flash-sale public view in `packages/contracts/src/bff/upstream.ts` with the real `packages/contracts` schema **under the same exported name** (`flashSalePublicSchema`; `flashSalesResponseSchema` stays the array) | WP-4: `upstream.ts` re-exports `flashSalePublicSchema` from `../orders/flash-sale`; test: BFF product-page spec keeps passing with a real view (`UPSTREAM_INVALID` absent), plus a contracts unit test parsing the AS-38 body |
| S38 | callers that target on `plan` put it into `EvalContext` themselves | no S11 caller evaluates flags; nothing to do (stated, not skipped) |
| S49 | `declareJobType` with a payload contract next to the `JobPayloads` augmentation for every job; `JobsService.cancel` discriminated result; catch `InvalidScheduleError` | WP-6: five declarations in `application/order.job-types.ts`; `FlashSaleService.cancel` handles the cancel result (not-found/already-running/ok are all fine); schedule registration catches `InvalidScheduleError` and logs `error` with the job name; AS-19, AS-23, AS-29 |
| S52 | use `getOrLoad` with `jitter`; drop the local promise-coalescing map | WP-9 (public view), WP-7 (directory); **no** coalescing map is written (R-08, R-02); AS-40 |
| gaps.md | A1–A28, B (D-6, D-7, D-8, D-12), C (4 flash findings) | "Gap coverage" below |
| S54 rule 4 | no new direct `sequelize.transaction`; `.tx.baseline` = 0 for the flash files | WP-5/6: `TransactionRunner.run` only; `grep -c "sequelize.transaction" libs/domains/orders` must not rise; no `// S54 T037 audit` comment is in the flash files (0 found) |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; domain `orders` in `packages/backend`; schemas in `packages/contracts/src/orders`.

**Primary Dependencies**: all present — `@nestjs/sequelize`, `TransactionRunner` (`@app/infrastructure/context`), `OutboxService` + `defineEvent` + topic registry, `JobsService` / `@JobHandler` / `declareJobType`, S50 `definePolicies` / `RateLimiterService.check`, S52 `CacheService.getOrLoad`, `RedisService` (ioredis, Lua), `Clock`/`CLOCK`, `ProductQueryService`, `ProductStockService`, `ShopScoped`, zod, `fast-check` (dev), `uuid` (v5 for claim ids). **No new library.**

**Storage**: PostgreSQL (`FlashSale` reshaped, `FlashSaleHistory` new, `StockReservation` indexes); Redis `flash:` key space (data-model §2); outbox/jobs tables of the infrastructure libs; Kafka `orders.events` (existing topic).

**Testing**: Jest e2e through `scripts/sdd/test-spec.sh` (six new files, [test-plan.md](test-plan.md)); table-driven unit specs under `domain/` with `fast-check`; real Postgres and Redis; faked only at the edges named in the test plan (token verification, payments confirmation, realtime transport, clock); faults by real mechanisms (Redis `CLIENT PAUSE`-style rule or an ACL denying commands, crash switch inside the lifecycle service, latch in the order write, refusing outbox appender). Playwright journey is the web capability's.

**Target Platform**: Linux; `apps/core` (HTTP, `OrdersModule`) and `apps/worker` (jobs, `OrdersWorkerModule`); no new app.

**Project Type**: web-service (backend domain) + contracts package.

**Performance Goals**: refusals (sold out, not admitted) < 50 ms p99, accepted < 150 ms p99 at 2,000 simultaneous buyers (SC-002, ops artifact); a drop attempt costs: one cart read, one cached directory lookup, ≤ 3 sequential Redis scripts + N≤3 bucket scripts (typical 1), then S10's two short transactions — a refusal costs 1–3 Redis round trips and **no** relational statement.

**Constraints**: no network call inside a transaction; 100 ms timeout on every hot-path Redis call; no retry inside a buyer request; keys have TTL with jitter; windows decided by the injected clock; fail closed.

**Scale/Scope**: 4 seller routes + 2 public routes, 7 events, 5 jobs (+1 alias), 2 rate policies, 11 config keys, 1 reshaped table + 1 new table + 3 indexes on `StockReservation`, ~14 new files in `domain/` (5 pure rules), 6 e2e files + 5 unit specs, 46 acceptance scenarios.

### Pool arithmetic and `statement_timeout` (III.12)

- Adds no pool. Buyer path: flash refusals hold **no** connection; accepted attempts use S10's two transactions (unchanged arithmetic). `FlashSaleService.create` is one transaction (sale + history + 2 job rows, ~5 statements). The verifier and sweeper process one sale per run with ≤ 200 claims, each durable lookup is one indexed statement (`StockReservation_flash_claim_uq`); `fleetConcurrency: 1` for both periodic jobs. Public routes: 0 database statements on a warm cache; a miss is one statement per 1 s per sale (single-flight).
- Statements are bounded: lists `limit ≤ 100`, sweeper ≤ 200, directory loader returns only `LOADED` sales (a few rows), batch ≤ 100 ids.

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I Layered modules / D-6 | PASS | ports in `domain/flash-ports.ts`; controllers call one application service; jobs call lifecycle service only; adapters in `infra/`. Closes A23 |
| II Pipeline and routing | PASS | `FlashSaleController` (seller), `FlashSalePublicController` (anonymous), zod pipe from contracts, `ShopScoped`, `@RateLimit` on public routes |
| III Data access / transactions | PASS | conditional updates + history in `TransactionRunner.run`; exclusion constraint instead of read-then-insert (III.6); no Redis/catalog call inside a transaction (III.3); shop in every predicate (III.4); keyset lists (III.2) |
| IV Services and communication | PASS | catalog only through R1 services; timeouts on every fast-store call (IV.6); one retry layer (jobs); outbox for events |
| V API contracts | PASS | schemas in `packages/contracts`; problem+json with stable codes; `201` + `Location`; `Retry-After` |
| VII Testing | PASS | e2e at the lowest layer, unit only for pure code; no mocked Redis; every AS has a row; hollow-test rule (L-003): no "A or B" assertions |
| VIII Operational safety | PASS | leases on every job (VIII.6), config validated at start-up, metrics/logs/spans (AS-42), alerts listed in FR-034 |
| IX Logical isolation | PASS | `FlashSaleHistory` registered as `orders`; zero foreign table access; sums over `StockReservation` are the domain's own table |
| X Monorepo/boundaries | PASS | barrel loses `FlashSaleModel`/`FlashStockService`; no `FlashReservationPort` export; `check:boundaries` |

**Gate result**: no unjustified violation. Justified complexity: a second reservation port (R-01) and a Lua script family (R-03) — each is forced by the spec (BEFORE_ORDER; cluster-safe never-oversell) and has an alternative recorded and rejected. **Post-design re-check**: same table, no change — the design adds no new import direction (`orders` → `catalog`/`tenancy` public services only).

## Project structure (additions to `packages/backend/libs/domains/orders`)

```text
domain/        flash-bucket-plan.ts  flash-sale-state.ts  flash-admission.ts  flash-drift.ts  flash-claim-state.ts
               flash-errors.ts  flash-ports.ts  (+ one .spec.ts each, except ports/errors)
application/   flash-sale.service.ts  flash-lifecycle.service.ts  flash-reservation.source.ts  flash-public.service.ts
               events/flash-sale-events.ts   (job declarations appended to order.job-types.ts)
api/           flash-sale.controller.ts  flash-sale-public.controller.ts  flash-sale.dto.ts (re-exports contracts)
infra/         flash-sale.repository.ts  flash-fast-store.redis.ts  flash-scripts.ts  flash-sale.directory.ts
               flash-sale.jobs.ts  models/flash-sale.model.ts  models/flash-sale-history.model.ts
flash-sale.module.ts (FlashSaleModule, imported by OrdersModule)   flash-sale-worker.module.ts (imported by OrdersWorkerModule)
*.e2e-spec.ts  flash-sale-schedule | -checkout | -lifecycle | -claims | -public | -observability
packages/contracts/src/orders/  flash-sale.ts  flash-sale-events.ts
packages/backend/migrations/    <ts>-flash-sales-expand.js   <ts>-flash-sales-contract.js
docs/spec/capabilities/S11-flash-sales.md   (living spec page; edit S10's page lines about the legacy route)
```

Deleted: `infra/flash/*`, `flash-sale-legacy.module.ts`, `flash-sale-legacy.e2e-spec.ts` (its scenarios — stock moves through the catalog on start and return — are re-proven by `flash-sale-lifecycle.e2e-spec.ts` AS-20/AS-25, L-017), `infra/models/` unchanged except the `FlashSale` model moves.

## Work packages (dependency order; tests first inside each)

- **WP-0 Living spec first (rule 0)**: create `docs/spec/capabilities/S11-flash-sales.md` (rules/behaviors with `[proof: S11 AS-nn]` and `[code: …]` clauses, `scope` globs for the new files), edit S10's page: replace the "legacy flash-sale route" bullet and line 132 (the legacy-jobs sentence) by a pointer to S11, update `R-…` lines that say flash is order-first if any; run `python3 scripts/livespec/check.py`. No `*.reviewed.json` exists for these pages (checked); if one appears, list it under "## Spec changes" in `gaps.md`.
- **WP-1 Pure domain + ports (A21, A5, A14, A9)**: the five pure modules and their unit specs (AS-44–AS-46) — `it.each` tables + `fast-check`; `flash-errors.ts`; `flash-ports.ts`. No Nest, no I/O.
- **WP-2 Contracts + config**: `packages/contracts/src/orders/flash-sale.ts`, `flash-sale-events.ts` (schemas from `contracts/http.md`/`events.md`), BFF re-export under the same name; the 11 config keys with validation (R-10); policies `orders.flash-reserve.user` and `orders.flash-sale-read.ip` in `rate-limit-policies.ts` (R-12).
- **WP-3 Data (A12–A15, A28)**: models, expand + contract migrations (data-model §1), repository (`infra/flash-sale.repository.ts`), `FlashSaleHistory`; ownership registry rows (`FlashSale`, `FlashSaleHistory` → `orders`). Proven by AS-14/AS-17/AS-18 and `migrate:up` / `migrate:down` on an empty and on a legacy-populated database (**migrate:down hazard**: run `down` only on a throwaway database — see S38 notes).
- **WP-4 Scheduling API (A12, A13, A15, A19 partial)**: `FlashSaleService.create/list/get/cancel`, controllers, validation classes, `Location`, jobs enqueued in the sale's transaction; `cancel` of a `LOADED` sale runs the reconcile mechanism early (units returned via `…:return` with `flash.return`). AS-14–AS-19.
- **WP-5 Fast store + pure glue (A2, A3, A4, A5, A8, A25, A26)**: Lua scripts (`flash-scripts.ts`), `FlashFastStore` adapter with timeouts and TTL jitter, `FlashSaleDirectory`. Each script has its e2e coverage through the public behavior (no mocked client).
- **WP-6 Lifecycle jobs (A1, A14, A16–A19)**: `FlashLifecycleService` (`load` create-if-absent order, `end`, `reconcile`, `verify`, `sweepClaims`, `checkSoldOut`), job handlers with payload contracts, alias for `flash-sale.start`, outbox events, metrics. AS-20–AS-29, AS-37.
- **WP-7 Seam into S10 (A6, A7, A10, A11)**: `FlashReservationSource` and the five edits (contracts/services.md), new problem classes in `order-problems.ts`, per-buyer limit + admission, `claimId` determinism, the 20 s margin rule. Existing S10 specs stay green; S11 AS-01–AS-13, AS-30–AS-36.
- **WP-8 Verification and remediation (A18)**: clamp, stop-selling, cancel-through-S10 with `discard` release, `unresolvedPaidUnits`. AS-27–AS-29.
- **WP-9 Public read (A13 public part)**: `FlashPublicService`, controller, `Cache-Control`, degraded answer. AS-38–AS-41.
- **WP-10 Observability (A20)**: counters/gauge from AS-42 (`flash_sale_reservations_total{result}`, `flash_sale_admission_rejected_total`, `flash_sale_stock_remaining{saleId}`, `flash_sale_stock_drift_units_total{direction}`, `flash_sale_phantom_stock_units_total`, `flash_sale_oversell_detected_total`, `flash_sale_claims_expired_total`, `flash_sale_reconcile_waiting`), log fields, spans; alert rules file next to S10's if the repo keeps one. AS-42.
- **WP-11 Removal and boundaries (A22, A23, A24, A27, B, C)**: delete legacy files, modules and exports; rewrite the two flash tests in `checkout.e2e-spec.ts` into the new specs (scenario preserved, L-017); update `orders-boundary.e2e-spec.ts`; update `scripts/load-tests/flash-sale.test.js`; run `check:table-ownership --strict`, `check:boundaries`, `tsc`, ESLint, the whole `libs/domains/orders` suite in batches (L-008), then start the real `apps/core` and `apps/worker` (L-004/L-015).

## Gap coverage

| Gap | WP | Gap | WP | Gap | WP |
|---|---|---|---|---|---|
| A1 | 5, 6, 7 | A11 | 7 | A21 | 1 |
| A2 | 5, 6 | A12 | 3, 4 | A22 | 11 |
| A3 | 5 | A13 | 4, 9 | A23 | 1, 11 |
| A4 | 5 | A14 | 1, 6 | A24 | 11 |
| A5 | 1, 5 | A15 | 3 | A25 | 5 |
| A6 | 5, 7 | A16 | 6 | A26 | 5 |
| A7 | 7 | A17 | 6 | A27 | 11 |
| A8 | 5, 7 | A18 | 8 | A28 | 3, 7 |
| A9 | 5 (zod-validated sale rows from the directory) | A19 | 6 | A10 | 7 |
| A20 | 10 | | | | |

B: D-6 → WP-1/11; D-7 → WP-11 (+ verified `ProductModel` no longer imported by flash code); D-8 → WP-11; D-12 → WP-6 (`applyStockDelta`). C: the four flash findings → WP-6 (jobs), WP-4 (controller `ProductModel`); S10-owned findings are not touched. "Constitution debt" items of `gaps.md` §B that are S11's are all in WP-1/6/11.

## Scenario → success criterion map

SC-001 AS-02 (+ a 200-for-50 variant, 50 repetitions) · SC-002 ops artifact (k6) · SC-003 AS-20/21/25/26/31 · SC-004 AS-27 (the first verification run corrects; interval 30 s ≤ 60 s) · SC-005 AS-24/25 assert the reconcile `runAt ≤ endsAt + 20 min` · SC-006 AS-16/18/19 (identical bodies compared byte-for-byte) · SC-007 AS-40/41 · SC-008 AS-13 · SC-009 AS-43.

## Risks and how the plan handles them

1. **Lua scripts diverge from the pure functions** (admission, draw plan): the pure functions are the *specification* of the scripts; AS-10/AS-11/AS-03 run through the real script with frozen clock and seeded start bucket so any divergence fails an e2e.
2. **Editing a built capability (S10)**: five edits, each isolated in one service, all existing S10 e2e files re-run first (WP-7 step 0 runs them green before editing).
3. **Crash windows** (AS-21, AS-35, AS-36): a crash switch in `FlashLifecycleService` and in `FlashReservationSource` (injectable `CrashPoint` test double registered only by the test kit) between named steps.
4. **Directory staleness**: bounded and argued in R-02; tests advance the clock past the 2 s TTL or call the directory's `refresh()` seam in the kit.
5. **Real start blocked in the sandbox**: recorded in `specs/UNVERIFIED.md` as `not run`, never as passed.
