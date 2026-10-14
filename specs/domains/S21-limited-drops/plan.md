# Implementation Plan: S21 — Limited-Drop Auctions (English auction, proxy bids, anti-sniping, reserve, exactly-once close, second chance, shill guard) — domain `auctions`

**Branch**: `S21-limited-drops` | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md` (v3.1.0). Design artifacts: [research.md](research.md), [data-model.md](data-model.md), [contracts/http.md](contracts/http.md), [contracts/services.md](contracts/services.md), [contracts/events.md](contracts/events.md), [quickstart.md](quickstart.md), [retired-scenarios.md](retired-scenarios.md).

## Summary

Today's `auctions` (1,225 lines) keeps live state in Redis behind a Lua script and drains it to Postgres through a relay; it writes orders and product stock with raw SQL and covers 5 of 54 scenarios. S21 replaces it with:

- **Pure rules in `domain/`**: `resolveBid` (proxy resolution, reserve), the transition table with `assertNever`, bidding window, `extendEnd`, bidder alias, runner-up selector, errors, ports (A21, A22, A28, D-6).
- **Durable decision** (R-01): one transaction per bid under a row lock on the `Auction` row; gapless `sequence`; bid row, auction update and outbox rows commit together. Redis is only view cache, limiter and realtime. Lua, stream, relay, `auction:active` are deleted (A1, A6, A23).
- **Lifecycle**: `SCHEDULED → OPEN → CLOSED | UNSOLD`, `CLOSED → SOLD | SECOND_CHANCE | UNSOLD`, cancel; history table; hold/return of the unit through `applyStockDelta` as durable-intent jobs; delayed open and close jobs per `(auction, endsAt)` plus a 30 s due sweeper (A4, A7, A10, A15, A16, A19).
- **Settlement**: after commit, one idempotent order command to S10 (`auction:<id>:winner`), event-driven `order.paid`/`order.cancelled` consumer, one second-chance offer, shill re-check at award (A8, A9, A11, A18).
- **S10 amendment** (R-04): `OrderCommandService.createFixedPriceOrder` does not exist yet; S21 builds it with an `EXTERNAL` reservation source.
- **Public side**: cached view, batch route for the BFF, bid history with aliases and cursor, `my-bid`, realtime `price`/`closed` (A12–A14).
- **Operations**: nine event types, metrics and alerts, daily partition job, configuration validated at startup (A17, A20, A25).
- **Cleanup**: barrel and module exports, FK to `Shop`, the old e2e spec, the notification test payload (A26, A27, A29, A30).

## Follow-ups from already-built specs (each is a requirement, planned and tested here)

| From | Requirement | Where planned / proven |
|---|---|---|
| S05 | price and stock only through `ProductQueryService.getProductsByIds` and `ProductStockService.applyStockDelta` (`operationId = <service>:<aggregate-id>:<step>`, compensation is a new operation); drop `ProductModel` and the `BelongsTo(Product)` in `bis-order-item.model.ts`; archived products refuse negative deltas (`unavailable`) | WP-4 (create check via `getProductsByIds`), WP-5 (`auctions:<id>:hold` / `:return`, the return a new operation; an `unavailable` hold failure is `CANCELLED(stock_hold_failed)` like `insufficient_stock`); the `BelongsTo(Product)` drop is S10's and is **verified already absent** (task: grep, no edit if absent); the auctions code never imports `ProductModel` (AS-52). Proven by AS-01, AS-02, AS-06, AS-29 |
| S10 | auction winner checkout needs an order-creating command S21 must specify; move off `BisOrderModel`/`OrderService`/`ORDER_MODELS` in `auction.jobs.ts` and the worker module; the classes leave the barrel when their last importer is gone | WP-3 builds `OrderCommandService` + `EXTERNAL` source (R-04, contract in `contracts/services.md`), WP-7 uses it; `getOrderLines` is not needed because S21 stores the order ID and price itself (spec). Barrel lines for `OrderService`, `BisOrderModel`, `ORDER_MODELS` **stay** because `asset-library` and `payments` e2e specs still import them (recorded in `gaps.md`); `orders-boundary.e2e-spec.ts` pins only the shrinking list. Proven by AS-27, AS-33, AS-52 |
| S13 | payments no longer touches `Product.quantity`; stock in payments-related flows is S10's reservation through `applyStockDelta` | nothing to build: the winner pays through the normal S13 path; the unit stays held by the auction (`EXTERNALLY_HELD`), S13 never moves it. Stated in the report |
| S28 | topic names and payloads in `contracts/events.md` are the consumer's assumption; confirm the names when the schema ships | WP-2 ships `auctionEventSchemas`; `contracts/events.md` uses S28's field names; follow-up recorded in `gaps.md` ("S28": switch the import); `notifications.e2e-spec.ts` payload updated (A30) |
| S28 (found at T006) | today's producer emits `price` (not `priceMinor`), no `auctionId`/`currency`/`auctionVersion`, no `second_chance_offered`/`sold` → dead-lettered as `invalid_payload` | WP-2 (schemas), WP-7/8 (every transition writes its event with `auctionVersion`), AS-49 asserts each payload parses with the S28 consumer schemas (`consumedAuctionEventSchemas`) — a parity assertion in `auction-operations.e2e-spec.ts` |
| S30 / S48 (S25/S24/S19/S11/S21/S38) | replace the loose `auctionPublicSchema` in `packages/contracts/src/bff/upstream.ts` with the real schema under the same exported name | WP-2: `upstream.ts` re-exports `auctionPublicSchema` from `../auctions/auction`; `auctionsResponseSchema` stays the array; proven by a contracts unit test parsing the AS-43 body and the BFF product-page spec staying green with `UPSTREAM_INVALID` absent |
| S48 (none built yet) | sections degrade as the spec requires | no code in S21; the batch route `GET /auctions?productIds=` (AS-44) is the R2 target |
| S49 | `declareJobType` with a payload contract next to each job; `JobsService.cancel` discriminated result; catch `InvalidScheduleError` | WP-5: `application/auction.job-types.ts` declares the seven types (loaded by `index.ts` import like orders); `AuctionScheduleService.cancel` handles the cancel result (`not_found`, `already_running`, `ok` are all fine because the handlers re-check state); the two periodic registrations catch `InvalidScheduleError` and log `error` with the job name; AS-35 sends malformed payloads |
| gaps.md | A1–A32, B (D-6, D-7, D-8, D-12), C (5 findings) | "Gap coverage" below |
| Rule 4 (S54) | no new direct `sequelize.transaction`; `.tx.baseline` is 0 | all transactions are `TransactionRunner.run`; the existing migration's `queryInterface.sequelize.transaction` is in `migrations/`, not in the domain; `grep -c "sequelize.transaction" libs/domains/auctions` stays 0; no `// S54 T037 audit` comment exists in the domain (0 found) |
| Rule 2 | criteria no test proves | SC-001 (200), SC-002, SC-004, SC-009, SC-011 (counts), start, fresh stack, Redis cleanup: `quickstart.md` "Ops artifacts" + 6 rows in `specs/UNVERIFIED.md` (written in this plan), status `not run` |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; domain `auctions` in `packages/backend/libs/domains/auctions`; schemas in `packages/contracts/src/auctions`.

**Primary Dependencies**: all present — `@nestjs/sequelize`, `TransactionRunner` (`@app/infrastructure/context`), `OutboxService` + `defineEvent`, `JobsService` / `@JobHandler` / `declareJobType`, `@Idempotent`, S50 `definePolicies` / `@RateLimit`, S52 `CacheService.getOrLoad`, S51 `RealtimePublisher`, `Projector` framework, `CLOCK`, `ProductQueryService`, `ProductStockService`, `ShopAccessService`, `EntitlementsService`, zod, `fast-check` (dev), Node `crypto` (HMAC alias). **No new library.**

**Storage**: PostgreSQL (`Auction` reshaped, `Bid` columns renamed, `AuctionHistory` new, `StockReservation.source` CHECK widened in `orders`); Redis only for view cache, limiter buckets, realtime; Kafka `auctions.events` (existing aggregate) and `orders.events` (consumed).

**Testing**: Jest e2e through `scripts/sdd/test-spec.sh` (seven new files, [test-plan.md](test-plan.md)) + one in `orders` (`order-command.e2e-spec.ts`); two table-driven unit specs under `domain/` with `fast-check`; real Postgres and Redis; faked only at the edges named in the test plan (token verification, S10's payment confirmation, realtime transport, entitlement lookup, clock). Playwright journey is the web capability's.

**Target Platform**: Linux; `apps/core` (`AuctionsModule`) and `apps/worker` (`AuctionsWorkerModule`); no new app.

**Project Type**: web-service (backend domain) + contracts package.

**Performance Goals**: 100 bids/s on one auction, p95 < 300 ms, p99 < 800 ms; public view served at ≤ 1 durable read/s/auction (SC-002, SC-011: ops artifacts, [quickstart.md](quickstart.md)).

**Constraints**: no network call inside a transaction (shill lookup, stock, order command, cache, realtime all outside); injected clock for every decision; durable store decides every bid; fail closed on limiter and tenancy for bids, fail open on reads; side effects after commit through `afterCommit`.

**Scale/Scope**: 4 seller routes + 5 public/bidder routes, 9 events, 7 job types (1 removed), 2 rate policies, 15 config keys, 1 reshaped table + 1 new table + 8 indexes, 5 pure modules, 7 + 1 e2e files, 2 unit specs, 54 acceptance scenarios.

### Pool arithmetic and `statement_timeout` (III.12)

- Adds no pool. A bid holds one connection for one short transaction: lock `SELECT … FOR UPDATE` (1), insert bid (1), update auction (1), outbox append (1), job upsert when the end moved (1) — ~5 statements, no I/O to other systems, so the hold time is single-digit milliseconds; waiters queue on the row lock (that is the serialization, bounded by the bid rate limiter, 10 per 10 s per bidder). `lock_timeout` for the bid transaction 2 s → `503 bid_unavailable` rather than hanging.
- The sweeper processes ≤ 200 auctions per run, one short transaction each; `fleetConcurrency: 1`. Reads: view = 0 statements on a warm cache, 1 on a miss per second per auction (single-flight); history, seller list ≤ 100 rows with keyset indexes.

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I Layered modules / D-6 | PASS | ports in `domain/auction-ports.ts`; three thin controllers call one application service each; jobs and the consumer call application services only; adapters in `infra/`. Closes A28 |
| II Pipeline and routing | PASS | zod pipes from `packages/contracts`, `ShopScoped`, `RequiresShopEntitlement`, `@RateLimit`, one `AuctionExceptionFilter` mapping domain errors (no branching in controllers; closes A13) |
| III Data access / transactions | PASS | `TransactionRunner.run` only; conditional updates asserting one row; partial unique index instead of read-then-insert (III.6); row lock serializes bids; shop in every seller predicate (III.4); keyset pagination (III.2); no I/O in transactions (III.3); statements bounded (III.12) |
| IV Services and communication | PASS | catalog, tenancy, orders only through R1 services; events through the outbox; saga step to S10 is an idempotent command (IV.3); timeouts on every cross-service call (IV.6) |
| V API contracts | PASS | schemas in `packages/contracts`; problem+json with stable `code`; `201`+`Location`; `Retry-After`; `Idempotency-Key` on create and bid (V.6) |
| VII Testing | PASS | e2e at the lowest layer that proves each AS (54 rows), unit only for pure logic; no mocked Redis/ORM; hollow-test rule (L-003): seams (`BidDecisionGate`, `CrashPoint`) are asserted reached, no "A or B" assertions; duplicate-delivery and invalid-payload tests for each job and the consumer (VII.4) |
| VIII Operational safety | PASS | leases on periodic jobs (VIII.6), config validated at startup, metrics/logs/spans/alerts (AS-51), fault drills for every Gate-9 item |
| IX Logical isolation | PASS | `AuctionHistory` registered; no FK to `Shop`; no foreign table access (5 findings → 0); `orders` edits are in `orders` code |
| X Monorepo/boundaries | PASS | barrel exports modules, rate policies and event definitions only; `check:boundaries` |

**Gate result**: no unjustified violation. Complexity recorded: (1) editing a built capability (S10) — forced by the spec's contract, smallest edit set, regression-first (research R-04); (2) a row lock on a hot auction — chosen over optimistic retry, with the queue-by-auction option left open (R-01). **Post-design re-check**: same table; the design adds no new import direction (`auctions` → `catalog`, `tenancy`, `billing`, `orders` public services; `orders` does not import `auctions`).

## Project structure (additions to `packages/backend/libs/domains/auctions`)

```text
domain/        proxy-bid.ts  auction-state.ts  auction-schedule.ts  bidder-alias.ts  runner-up.ts
               auction-errors.ts  auction-ports.ts  auction-metrics.ts  auction-config.ts
               proxy-bid.spec.ts  auction-state.spec.ts           (covers the four non-proxy pure modules)
application/   auction-schedule.service.ts  bid.service.ts  auction-close.service.ts  settlement.service.ts
               auction-query.service.ts  auction.job-types.ts  auction-test-seams.ts
               events/auction-events.ts
api/           auction-seller.controller.ts  auction-public.controller.ts  auction-bid.controller.ts
               auction.exception-filter.ts  auction.dto.ts (re-exports contracts)
infra/         auction.repository.ts  bid.repository.ts  product-catalog.adapter.ts  auction-stock.adapter.ts
               shop-membership.adapter.ts  order-request.adapter.ts  auction-view.cache.ts
               auction-realtime.adapter.ts  auction.jobs.ts (rewritten)  auction-settlement.consumer.ts
               models/auction.model.ts (reshaped)  models/bid.model.ts  models/auction-history.model.ts
auctions.module.ts  auctions-worker.module.ts  rate-limit-policies.ts  realtime-topics.* (kept)  index.ts (trimmed)
*.e2e-spec.ts  auction-schedule | -bidding | -shill-guard | -anti-sniping | -close | -public | -operations
packages/contracts/src/auctions/   auction.ts  auction-events.ts  index.ts
packages/backend/migrations/       <ts>-auctions-expand.js  <ts>-auctions-contract.js  <ts>-stock-reservation-external-source.js
libs/domains/orders/               application/order-command.service.ts  domain/order-command.ts  order-command.e2e-spec.ts
                                   (+ edits to domain/ports.ts, application/reservation-release.service.ts, orders.module.ts, index.ts)
docs/spec/capabilities/S21-limited-drops.md   (living spec page) ; edit S10 page (line 134 and exports)
scripts/load-tests/auction.test.js            (k6, ops artifact, not run)
```

Deleted: `infra/place-bid.lua.ts`, `infra/bid-relay.service.ts`, `application/auction.service.ts`, `auctions.e2e-spec.ts` (scenarios carried, see [retired-scenarios.md](retired-scenarios.md)). `libs/domains/notifications/notifications.e2e-spec.ts`: one payload edit (A30).

## Work packages (dependency order; tests first inside each)

- **WP-0 Living spec first (rule 0)**: create `docs/spec/capabilities/S21-limited-drops.md` (Purpose, Entry points, Rules with `[proof: S21 AS-nn]` and `[code: …]` clauses, `scope` globs for the domain and `packages/contracts/src/auctions/**`), edit S10's page (the `OrderService` sentence at line 134 and the export list: `OrderCommandService`, `EXTERNAL` reservation), run `python3 scripts/livespec/check.py`. No `*.reviewed.json` exists; if one appears, list it under "## Spec changes" in `gaps.md`.
- **WP-1 Pure domain + ports (A21, A22, A28, AS-53, AS-54)**: `proxy-bid.ts`, `auction-state.ts`, `auction-schedule.ts`, `bidder-alias.ts`, `runner-up.ts`, `auction-errors.ts`, `auction-ports.ts`, `auction-config.ts` and the two unit specs first (`it.each` tables of AS-11–AS-15 + `fast-check`). No Nest, no I/O.
- **WP-2 Contracts + config + policies**: `packages/contracts/src/auctions/{auction,auction-events}.ts` from `contracts/http.md`/`events.md`; BFF re-export of `auctionPublicSchema`; 15 config keys with validation; `auctions.read.ip` policy; contract parity assertion against `notifications/consumed-events.ts` schemas.
- **WP-3 S10 amendment (R-04)**: run the whole `orders` suite green first (batches, L-008); add the `source` CHECK migration, `EXTERNAL` in ports, release skip, `OrderCommandService`, `OrderCommandRejectedError`, `order-command.e2e-spec.ts`; re-run `orders` suite. Gate: green before WP-7 starts.
- **WP-4 Data + repositories (A15, A16, A19, A20, A27)**: models, expand and contract migrations ([data-model.md](data-model.md) §1–3), `AuctionRepository`/`BidRepository`, ownership registry (`AuctionHistory`), partial unique index mapping. Proven by migration up/down on an empty and on a legacy-populated database (down only on a throwaway DB) and by AS-05.
- **WP-5 Scheduling, lifecycle and jobs (A4, A7, A10, A15, A19, A21; AS-01–AS-09, AS-35)**: `AuctionScheduleService` (create with `@Idempotent`, list, read, cancel, hold/open handlers), `AuctionStockPort`/`ProductCatalogPort` adapters, `auction.job-types.ts`, rewritten `auction.jobs.ts` handlers for open/hold/return/sweep/partitions, `CrashPoint`, seller controller.
- **WP-6 Bidding (A1–A3, A11, A12, A21–A24; AS-10–AS-26, AS-40, AS-41)**: `BidService` (limiter via guard, shill lookup before the transaction, lock → `resolveBid` → rows → outbox → after-commit cache delete + realtime), `BidDecisionGate`, `my-bid`, anti-sniping inside the same transaction, close re-arm on end change, exception filter mapping `503 bid_unavailable`, `429`, idempotency. **Delete the Lua script, relay, `auction:active`** here.
- **WP-7 Close and settlement (A5, A6, A8, A9, A18; AS-27–AS-34, AS-42)**: `AuctionCloseService` (check membership outside, lock, re-evaluate, `CLOSED`/`UNSOLD`, jobs, `closed` push), `SettlementService.requestOrder` + `auctions.request-order` handler through `OrderRequestPort`, `sweep-due` repairs, `AuctionSettlementConsumer`, `SOLD`.
- **WP-8 Second chance (AS-36–AS-39)**: runner-up selection from `BidRepository`, eligibility batch check, offer transition + job, outcomes, late-payment anomaly, pre-ID transient path, version guard.
- **WP-9 Public reads (A13, A14; AS-43–AS-48)**: `AuctionQueryService` (view with `getOrLoad`, batch, history with keyset, alias), public controller, `Cache-Control`, `auctions.read.ip`, degraded path when the cache store is down, realtime topic registry unchanged.
- **WP-10 Observability, partitions, isolation, cleanup (A17, A20, A25, A26, A29–A32; AS-49–AS-52)**: metrics, log fields, spans, alert definitions next to the repo's other alert files; `ensure-bid-partitions`; barrel and module trim; notifications test payload; delete the old e2e spec; k6 script `scripts/load-tests/auction.test.js`; `check:table-ownership --strict` (0), `check:boundaries`, `tsc`, ESLint, `grep -c sequelize.transaction` = 0.
- **WP-11 Whole-capability proof**: whole `libs/domains/auctions` suite in batches (L-008); `orders` and `notifications` regression; contracts tests; `python3 scripts/livespec/check.py`; start the real `apps/core` and `apps/worker` each alone (L-004, L-015, L-018) — recorded in `specs/UNVERIFIED.md` as `not run` if the sandbox denies it, never as passed.

## Gap coverage

| Gap | WP | Gap | WP | Gap | WP |
|---|---|---|---|---|---|
| A1 | 6 | A12 | 6, 9 | A23 | 6, 7 |
| A2 | 5, 6 | A13 | 5, 9 | A24 | 2, 6 |
| A3 | 1, 6 | A14 | 9 | A25 | 10 |
| A4 | 1, 5 | A15 | 4, 5 | A26 | 10 |
| A5 | 1, 7 | A16 | 4 | A27 | 4 |
| A6 | 7 | A17 | 2, 5–8, 10 | A28 | 1, 4 |
| A7 | 5, 7 | A18 | 7 | A29 | 10 |
| A8 | 3, 7 | A19 | 4 | A30 | 10 |
| A9 | 8 | A20 | 4, 10 | A31 | 5 (`auction.opened` producer), 10 |
| A10 | 5 | A21 | 1, 6 | A32 | out of scope (web capability), `quickstart.md` notes the UI row |
| A11 | 6, 7 | A22 | 1 | | |

B: D-6 → WP-1, 4; D-7 → WP-3, 7, 10 (auctions no longer import order models; remaining importers are other specs'); D-8 → WP-10; D-12 → WP-5 (stock via `applyStockDelta`), WP-3/7 (orders via command). C: the five findings → WP-5 (`Product` ×2), WP-7 (`BisOrderItem`, `ShopOrder`, `BisOrderModel`); proven by `check:table-ownership --strict`. Constitution-debt items of `gaps.md` §B that are S21's are all in WP-1/4/5/7/10.

## Scenario → success criterion map

SC-001 AS-19 (50 bidders × 50 runs; 200 bidders is an ops artifact) · SC-002 ops artifact (k6) · SC-003 AS-28/29/30/33/37/38 (accounting: hold = sold + returned asserted at the end of each) · SC-004 AS-26/27/31 (mechanism; percentages are an ops artifact) · SC-005 AS-22 · SC-006 AS-24/25/54 · SC-007 AS-13/29/36/38/42 · SC-008 AS-07/43/46/47 (serialized-output scans) · SC-009 AS-04/18 (counts reduced; larger is an ops artifact) · SC-010 AS-52 + `check:table-ownership --strict` · SC-011 AS-43/44 (single-flight); 1,000 viewers is an ops artifact.

## Risks and how the plan handles them

1. **Editing a built capability (S10)**: WP-3 runs the whole `orders` suite green before and after; the edit set is one new service, one skipped branch, one CHECK widening.
2. **Row-lock contention on a hot auction**: bounded transaction (5 statements, no I/O), `lock_timeout` 2 s, per-bidder limiter; AS-19 runs 50 concurrent bidders 50 times; the queue-by-auction option stays open without a contract change.
3. **Shill check versus lock (AS-42)**: membership is read outside the transaction; the close re-evaluates after taking the lock and never awards an unchecked leader (loop ≤ 3 then defer to the next sweep). A test forces a bid between check and lock with the decision gate.
4. **Consumer race before the order ID is stored (AS-39)**: transient redelivery, bounded by the framework's retry budget; the sweeper's re-run of the request job closes the gap; the dead-letter replay is documented as an operator step.
5. **Crash windows** (AS-06, AS-33): `CrashPoint` seams in `AuctionScheduleService` and `SettlementService`, registered only by the test kit and asserted reached (L-003).
6. **Time-based tests**: every decision uses the injected clock; tests advance it, never sleep (L-007).
7. **Wiring failures (L-015, L-018)**: both apps start alone as the last step; module imports are checked by booting `apps/core` and `apps/worker` module graphs in the e2e suite (`Test.createTestingModule({ imports: [AppModule] })`), not hand-built modules.
8. **Queue/topic existence (L-002, L-011)**: `auctions.events` already exists via `forAggregates`; the plan adds no queue; the consumer's subscription to `orders.events` is checked by the doctor.
9. **Real start blocked in the sandbox**: recorded in `specs/UNVERIFIED.md` as `not run`, never as passed.
