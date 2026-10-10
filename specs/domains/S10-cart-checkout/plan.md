# Implementation Plan: S10 — Cart, Checkout, Stock Reservation, Order State Machine, Payment Webhook (domain `orders`)

**Branch**: `S10-cart-checkout` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md` (v3.1.0). Design artifacts: [research.md](research.md), [data-model.md](data-model.md), [contracts/http.md](contracts/http.md), [contracts/services.md](contracts/services.md), [contracts/events.md](contracts/events.md), [quickstart.md](quickstart.md).

## Summary

S01, S03, S05, S49, S50, S52, S53 and S54 are built; S13 (payments) and S45/S11/S12 are not. `orders` today creates an order and decrements `Product.quantity` by raw SQL in one transaction, decides idempotency with a hand-written lookup, runs the Stripe webhook inline with swallowed errors and raw SQL on the inbox table, returns ORM models, imports `Product`, `Payment` and `User` models, and carries the flash-sale code. The plan rebuilds the domain in the S01/S03/S05 shape without changing the table owner:

- **Pure rules in `domain/`**: order state machine with reasons (`assertNever`), largest-remainder money allocation and shop split, stock-operation builder, cart merge, guest-cart token, Stripe signature verification, cursor codec, error classes with stable `code`s, port interfaces and tokens (closes D-6, A32–A35, A41).
- **Cart** stays in DynamoDB; atomic idempotent merge by `TransactWriteItems`; dedicated cookie secret; expired lines filtered on read (D-2).
- **Checkout** is `@Idempotent()` (S54) plus the order row as the durable key/fingerprint guard; one checkout per buyer by a Redis lock; a **saga**: order `PENDING` committed → stock through `ProductStockService.applyStockDelta` (no transaction spans two domains) → `RESERVED` with outbox row, expiry job and realtime push; `202` + `Location` (D-3, D-4).
- **One state writer**: `OrderLifecycleService.transition` (conditional update, history row, version, outbox, shop-order and reservation propagation in one `TransactionRunner.run`), used by checkout, webhook, payment consumer, expiry, buyer cancel and `OrderFulfilmentService`.
- **Jobs** (S49): expiry per order, sweeper, `PENDING` recovery, retrying release, cart cleanup, webhook processing, inbox purge, title backfill (D-5).
- **Webhook**: signature over the raw body (current + previous secret, ±300 s), 64 KiB cap, `InboxService.claim` + job enqueue in one transaction, `200` before processing, result states via `InboxService.markStatus`, payment confirmed through `PaymentStatusPort` (S13 not built: fail-closed default), refund command for late payments (D-6, D-7).
- **Reads** as DTOs: keyset history over a partial covering index, seller list, `OrderQueryService`, `OrderFulfilmentService`; schemas in `packages/contracts/src/orders`.
- **Boundaries**: models lose `User`, `Payment`, `Product` associations; `ORDER_MODELS` loses `Product`, `Payment`; webhook and cancel stop raw SQL on foreign tables; the barrel gets the new exports and a **TRANSITIONAL block** for names other capabilities still import (D-1). Flash-sale files stay compiled in `FlashSaleLegacyModule` until S11 (D-9).

## Follow-ups from already-built specs (each is a requirement, planned and tested here)

| From | Requirement | Where planned / proven |
|---|---|---|
| S01 | drop the `User` association and import in `bis-order.model.ts` (plain `userId`) | WP-2 (model), AS-68 check, `orders-boundary.e2e-spec.ts` |
| S01 | `RateLimitModule.forRoot()` wherever the app must enforce `@RateLimit` | WP-3: the orders e2e kit (`libs/domains/orders/testing/orders-app.ts`) imports `RateLimitModule.forRoot()` so `429` is real (AS-10, AS-26, AS-52); `core` already installs it |
| S01 | replace `issueTokensFor` in `cart.e2e-spec.ts` / `checkout.e2e-spec.ts` with the session fixture | WP-3 (kit uses `identity/testing/auth-app.ts`); both specs are rewritten in WP-3 / WP-8 |
| S01 | `Firewall` no longer takes `throttle`/`skipThrottle`; sensitive routes use `Firewall({ sensitive: true })` instead of `@UseGuards(SessionNotRevokedGuard)` | WP-3, WP-8, WP-10: cart controller anonymous allowed; merge/checkout/orders session; `checkout` and `cancel` `sensitive: true`; no `SessionNotRevokedGuard` anywhere in the domain |
| S05 | price and stock only through `getProductsByIds` / `applyStockDelta`, `operationId = <service>:<aggregate-id>:<step>`, compensation is a new operation | WP-7 (`orders:<orderId>:reserve:<productId>` / `…:release:<productId>`; AS-31, AS-35, AS-38) |
| S05 | drop `ProductModel` and `BelongsTo(Product)` in `bis-order-item.model.ts`; archived products refuse negative deltas (`unavailable`) | WP-2; WP-7 maps the `unavailable` failure to `422 product_unavailable` (and `out_of_stock` for `insufficient`); test in `checkout.e2e-spec.ts` AS-21 (archived product) |
| S50 | replace `@SkipThrottle()` on the Stripe webhook | WP-11: removed; route carries `@RateLimit('orders.webhook.ip')` (FR-042) rather than `@RateLimitExempt`; AS-52 proves 301 forged requests → `429` |
| S50 | `@RateLimit` is metadata only; enforcement by `RateLimitModule.forRoot()`; new apps/specs that want the limit import it | WP-3 (kit), WP-9, WP-11; `OrdersModule` keeps `RateLimitModule.forFeature(ordersRatePolicies)` |
| S53 | replace the raw SQL on `ProcessedWebhookEvent` (`stripe-webhook.controller.ts:49`, G-53) with `InboxService.claim('stripe', eventId)` / `markStatus` from an application service; adopt envelope fields in `order-payment.listener.ts` | WP-11 (`WebhookIntakeService`, `WebhookProcessorService`), WP-12 (consumer on the S53 framework, envelope fields, zod, DLQ); AS-43, AS-44, AS-50, AS-68 |
| gaps.md | A1–A43, B (D-6, D-7, D-8, D-10, D-11, D-12, D-15, D-17), C (12 findings), D1–D9, E (migrations) | "Gap coverage" below |
| S54 rule 4 | no new direct `sequelize.transaction`; migrate `order.jobs.ts:125` (`// S54 T037 audit`) | WP-9 / WP-13: count `1 → 0`; gate `.tx.baseline` |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; `packages/backend` domain `orders`; schemas in `packages/contracts`; the web screens are W03's (only the type/route adaptation noted in `gaps.md` follow-ups).

**Primary Dependencies**: all present: `@nestjs/sequelize`/`sequelize-typescript`, `TransactionRunner`/`@Transactional` (`@app/infrastructure/context`), `@Idempotent` (`…/idempotency`), `InboxService`, `OutboxService` + `defineEvent` + `TopicRegistry`, `JobsService`/`@JobHandler`/`declareJobType`, S50 `definePolicies`/`@RateLimit`, `RealtimePublisher`, `DynamoService` (`@aws-sdk/lib-dynamodb`), Redis client for the checkout lock, `Clock`/`CLOCK`, `ProductQueryService`/`ProductStockService`, `ShopQueryService`/`ShopScoped`, identity `Firewall`/`AuthenticatedUser`, zod, `fast-check` (dev). No new library.

**Storage**: PostgreSQL shared `public` schema: `BisOrder`, `BisOrderItem`, `ShopOrder`, `OrderEvent`, `StockReservation` (altered, no new table, so no new ownership row; `FlashSale` untouched); DynamoDB `Carts`; Redis lock key; inbox/idempotency/job/outbox rows through the owning infrastructure libs. Kafka `orders.events` (existing topic), `payments.events` (consumed), SQS `orders.refund_requested` (produced).

**Testing**: Jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (eight files in [test-plan.md](test-plan.md)); table-driven unit specs under `domain/` with `fast-check` for money, merge and the stock builder; real Postgres/Redis/Dynamo/Kafka stand-ins; faked only at edges (payments status service until S13, discount source, provider signatures use the real scheme with a test secret, fault gates for stock/Dynamo/outbox/realtime/limiter). Playwright is W03's.

**Target Platform**: Linux containers: `apps/core` hosts `OrdersModule` (HTTP, R1 services, `RateLimitModule.forRoot()` already installed); `apps/worker` hosts `OrdersWorkerModule` (jobs, `payments.events` consumer through `ProjectionsModule`); `apps/sse-gateway` keeps `ExportJobTopicsModule`. No new deployable app (I.6).

**Project Type**: web-service (backend domain) + contracts package.

**Performance Goals**: checkout p99 < 800 ms at 200 concurrent buyers: two short transactions, one batched catalog read, one stock call (one transaction in the catalog), no N+1; cart operations: 1–2 Dynamo calls, p99 < 50 ms, no SQL; webhook ack = signature + one transaction (inbox claim + job insert); history page = one index-only statement; `getOrderLines` = one statement for ≤ 500 ids.

**Constraints**: no network I/O inside a transaction (catalog, stock, discounts, tenancy, Dynamo, Redis, realtime and the delayed-job enqueue all outside); every outbound call has a timeout (catalog 1 s, stock 2 s, discounts 250 ms, shops 1 s, status 2 s, cart Dynamo 500 ms, Redis lock 100 ms) and the whole checkout 10 s; retries only inside jobs (one layer); no unbounded statement (sweeper ≤ 200, release ≤ 100 rows, recovery ≤ 100, purge ≤ 1,000, backfill ≤ 200); logs never carry bodies, signatures, cookies or idempotency keys.

**Scale/Scope**: 9 routes (1 new: the seller list; 8 re-shaped; the flash-sale route stays legacy and is not counted), 5 events + 1 command, 8 job types, 1 consumer, 3 new rate policies, 7 in-repo importer adaptations, 68 acceptance scenarios (eight e2e files, six unit specs).

### Pool arithmetic and `statement_timeout` (III.12)

- `orders` adds no pool; it uses the shared pool of S54 (`db_pool_max` P = 10 per instance × 12 database-holding instances at the production ceiling = 120, plus read replica 30 = 150, under `max_connections` 200 with 25 reserved; see S54 plan "Pool arithmetic").
- A checkout holds a connection only inside Tx 1 (≈ 5 statements, bulk inserts: order, items, shop orders, reservations, history) and Tx 2 (≈ 8 statements incl. one outbox row); catalog read, shops, discounts, stock call, Redis lock and Dynamo never hold one. At 200 concurrent buyers the in-transaction time is ≈ 2 × 10 ms each, so peak connection demand is far below P; the per-buyer lock caps one buyer to one checkout.
- Sweeper/recovery/release jobs process orders one transaction each (≤ 200 per 60 s), `fleetConcurrency: 1`. Webhook ack uses one transaction (inbox claim + job row). `orders.expire-reservation` `concurrency: 50` per worker instance is bounded by P through the pool queue (each run is one short transaction); the worker pool is the same P = 10, so the handler waits on the pool, never opens extra connections.
- Pool-wide `db_statement_timeout_ms` applies; the history query, seller list and `getOrderLines` are single indexed statements, `AS-60` proves the plan.

## Constitution Check

*GATE: passes before Phase 0 and re-checked after Phase 1 design (below).* Each line is a "Pull Request Compliance Gate".

| # | Gate | Status | How |
|---|---|---|---|
| 1 | Boundaries (I.1–I.6, Communication Matrix, no `forwardRef`, no `Scope.REQUEST`) | **Pass** (one justified exception, CT-1) | Layers per [Project Structure](#source-code-repository-root); `application/` reaches `infra/` only through `domain/ports.ts` tokens; `domain/` takes `now` as a parameter, imports nothing from Nest/Sequelize/AWS; no new app. The legacy `OrderService`/flash files keep their current imports until S21/S11 (CT-1, CT-3). |
| 2 | Controllers (II.1), no HTTP `try/catch` outside the filter | **Pass** | Controllers validate DTO, call one service, map the result; the cookie handling is a small `CartIdentityInterceptor`-free helper in `api/` that sets/clears headers only; all problems are `AppError` subclasses raised in `application/`/`domain/`. |
| 3 | Data access: principal-scoped queries (III.4), no network I/O in transactions (III.3), store-enforced invariants (III.6), integer money (III.8), keyset pagination (III.10) | **Pass** | `WHERE id = :id AND "userId" = :u` for get/cancel/payable (no get-then-check); transitions are conditional updates (III.7); stock invariant stays in S05; unique `(userId, idempotencyKey)`, `(bisOrderId, shopId)`, `(bisOrderId, productId)`; `CHECK` on statuses; keyset with id tiebreaker; BIGINT minor units, no float. |
| 4 | Migrations expand/contract with `lock_timeout` (III.11) | **Pass** | [data-model.md](data-model.md) expand → validate → backfill → contract (contract is a later release; not part of this deploy); concurrent index creation. |
| 5 | Messaging: outbox, idempotent zod-validated consumers, timeouts (IV.4–IV.6) | **Pass** | Five events through `OutboxService.append` in the transition transaction; `payments.events` consumer validates with zod, DLQ, inbox `recordOnce`; every outbound call has a timeout. |
| 6 | Contracts: DTOs, `packages/contracts` schemas, problem+json, `Idempotency-Key` (V) | **Pass** | `packages/contracts/src/orders/*`; e2e parse every body; `@Idempotent()` on checkout (webhook is deduplicated by provider id, V.8). |
| 7 | Web | n/a | W03 owns screens; `gaps.md` lists the type changes. |
| 8 | Tests: VII.2/VII.3 for every touched endpoint, VII.4 for consumers, Test plan updated, green run recorded (VII.8/9) | **Pass (to be proven by WP-14)** | [test-plan.md](test-plan.md) 68 rows; the recorded green run is the WP-14 acceptance; no spec injects foreign models. |
| 9 | Operational: no secrets/PII in logs, probe semantics, jobs single-run and idempotent (VIII) | **Pass** | AS-66/AS-67; webhook body never logged or stored; every job claims by conditional state or `SKIP LOCKED`, `fleetConcurrency: 1` where promised. |
| 10 | Database isolation (IX) | **Pass after WP-13 (one named remainder, CT-2)** | 12 findings → 0 for the domain's own code; the `order-export.service.ts` `Product` join is S12's (CT-2); no new table; associations to foreign owners removed; inbox through `InboxService` only; cross-domain reads are R1 (`ProductQueryService`, `ShopQueryService`, payments port). |
| 11 | Monorepo boundaries (X) | **Pass (one exception, CT-1)** | Imports only via entry points; barrel exports services, DTO types, errors, event definitions; the transitional block is explicit. |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S10-cart-checkout/
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── http.md
│   ├── services.md
│   └── events.md
├── spec.md  test-plan.md  gaps.md  questions.md   # inputs (gaps.md gains "Sibling-spec follow-ups")
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
packages/contracts/src/orders/
├── cart.ts  checkout.ts  order.ts  order-events.ts  payment-events.ts  webhook.ts  index.ts   # D8 schemas; exported from src/index.ts

packages/backend/libs/domains/orders/
├── api/
│   ├── cart.controller.ts           # GET /cart, PUT /cart/items/:id, POST /cart/merge (cookie header helper in cart-cookie.ts)
│   ├── checkout.controller.ts       # POST /checkout (@Idempotent, Firewall sensitive)
│   ├── orders.controller.ts         # GET /orders, GET /orders/:id, POST /orders/:id/cancel
│   ├── shop-orders.controller.ts    # GET /shops/:shopId/orders (ShopScoped('orders.read'))
│   ├── stripe-webhook.controller.ts # raw body, signature, intake only
│   └── *.dto.ts                     # request DTO classes for ValidationPipe, mapped to contracts schemas
├── application/
│   ├── cart.service.ts  checkout.service.ts  order-lifecycle.service.ts  order-cancellation.service.ts
│   ├── order-query.service.ts  order-fulfilment.service.ts  reservation-recovery.service.ts
│   ├── webhook-intake.service.ts  webhook-processor.service.ts  payment-result.service.ts
│   ├── order.service.ts             # compat facade (same constructor), transitional (research D-1)
│   └── events/order-events.ts       # defineEvent definitions on the contracts schemas
├── domain/
│   ├── order-state.ts  money-allocation.ts  stock-operations.ts  cart-merge.ts  guest-cart-token.ts
│   ├── webhook-signature.ts  order-cursor.ts  order-errors.ts  order-metrics.ts  ports.ts
│   └── *.spec.ts  (guest-cart-token, cart-merge, money-allocation, stock-operations, order-state, webhook-signature)
├── infra/
│   ├── models/                      # associations to User/Product/Payment removed; new columns
│   ├── order.repository.ts  reservation.repository.ts  order-history.repository.ts  shop-order.repository.ts
│   ├── cart.dynamo-store.ts  checkout-lock.redis.ts
│   ├── catalog.adapter.ts  shop-directory.adapter.ts  payment-status.adapter.ts  discounts.adapter.ts
│   ├── realtime.adapter.ts  refund-command.adapter.ts  catalog-reservation-source.ts
│   ├── order.jobs.ts                # 8 job handlers (TransactionRunner only)
│   ├── payments-events.consumer.ts  # replaces order-payment.listener.ts
│   └── flash/                       # moved, behaviour unchanged: flash-stock.service.ts(+spec), flash-sale.model.ts, flash-sale.jobs.ts, flash-sale.controller.ts
├── testing/orders-app.ts            # e2e kit: real modules + RateLimitModule.forRoot() + identity fixture + fakes for edges
├── orders.module.ts  orders-worker.module.ts  flash-sale-legacy.module.ts
├── rate-limit-policies.ts           # + orders.cart-write.identity, orders.cancel.user, orders.webhook.ip
├── index.ts                         # new exports + TRANSITIONAL block
└── *.e2e-spec.ts                    # the eight files of test-plan.md + orders-boundary.e2e-spec.ts (AS-68)

packages/backend/migrations/         # 20261010…-orders-s10-expand-columns.js, -expand-indexes.js, -validate.js
packages/backend/db/ownership.ts     # no new table; unchanged unless the check asks
```

**Structure Decision**: web-service backend domain plus a contracts package. No new deployable (I.6): HTTP in `core`, jobs/consumer in `worker`. The flash code is parked in `infra/flash/` + `flash-sale-legacy.module.ts` so S11 deletes one folder.

## Work packages

Order follows `gaps.md` section F; each package ends with its narrowest test through `test-spec.sh` (or `npx jest` for units). The `tasks.md` of `/speckit-tasks` splits them.

| WP | Content | Scenarios / gaps |
|---|---|---|
| WP-0 | Baseline: record `check:table-ownership` (12 for `orders`) and direct-transaction count (1); run the existing orders and the importer suites (catalog-sync, auctions, notifications, payments, shop-functions) to know what is green today; confirm `DynamoDB Local` supports `TransactWriteItems` and `InboxService.markStatus`/`purge` signatures; confirm the idempotency fingerprint of "no body" vs `{}` (D-3). | — |
| WP-1 | **Contracts and config**: `packages/contracts/src/orders/*` (D8), config keys + startup validation (D7), error classes with codes in the problem catalog, rate policies, metrics module, clock use (A11, A35, A36). | D8, D7, FR-058 |
| WP-2 | **Domain layer, pure**: `order-state` (reasons, "already applied", `assertNever`), `money-allocation`, `stock-operations`, `cart-merge`, `guest-cart-token`, `webhook-signature`, cursor codec; six unit specs with `fast-check`. **Models**: drop `User`/`Payment`/`Product` associations and lazy accessors, new columns, `ORDER_MODELS` slimmed; migrations expand 1–2 + validate. | AS-11, 12, 23, 25, 35, 53, 54; A10, A15, A37, A41; D-11, D-17 |
| WP-3 | **Cart**: Dynamo store (expiry filter, `META` cap, atomic merge), `CartService`, controller (no cookie on GET, `200` merge, cookie clear), policy `orders.cart-write.identity`; the e2e kit `testing/orders-app.ts` (session fixture, `RateLimitModule.forRoot()`, fakes); rewrite `cart.e2e-spec.ts`. | AS-01–AS-10; A29, A30, A31, A34, A40 |
| WP-4 | **Ports and adapters**: repositories (order, reservation, history, shop order), catalog/shop/payment-status/discount/realtime/refund adapters with timeouts, `CatalogReservationSource` (`ReservationSource` seam), Redis checkout lock. | A4, A9, A14, A32, A33; D-6 |
| WP-5 | **`OrderLifecycleService`** (single writer: conditional update, history with actor, version, outbox, shop-order + reservation propagation, realtime after commit) + the five event definitions; `OrderFulfilmentService`; `order-lifecycle.e2e-spec.ts` (incl. 20-way and 50-run race tests). | AS-54–AS-57, AS-64, AS-65; A15, A27, A28 |
| WP-6 | **Checkout use case** on the idempotency facility: lock, cart read, prices and shop status, discounts and allocation, `expectedTotalMinor`, Tx 1, response `202` + `Location`, order-row key/fingerprint guard (D-3); `checkout.e2e-spec.ts` rewritten (session fixture, HTTP only). | AS-13–AS-30 (without stock faults); A1–A4, A10–A14 |
| WP-7 | **Saga**: reserve via `applyStockDelta` (sorted ops), `RESERVED`/`out_of_stock` transitions, expiry job, sweeper, `PENDING` recovery, `RELEASE_PENDING` release job, cart cleanup job, `orders.clear-cart`; `checkout-stock.e2e-spec.ts` with the 200/50 race and fault gates. | AS-29–AS-40; A5–A8, A13 |
| WP-8 | **Cancel and reads**: `OrderCancellationService` (scoped update, no get-first), `OrderQueryService`, cursors, partial covering index, seller list controller, `getPayableOrder`; `order-read.e2e-spec.ts` (plan test after `VACUUM`). | AS-40, AS-55, AS-58–AS-63; A24–A26 |
| WP-9 | **Jobs registration** in `OrdersWorkerModule` (declareJobType, schedules, single-run), `order.jobs.ts` rewritten on `TransactionRunner` (direct-transaction count → 0), `order-events.e2e-spec.ts` (observability, jobs twice/on two instances). | AS-36, 37, 66, 67; A42; S54 rule 4 |
| WP-10 | **Controllers re-pointed** to `AuthenticatedUser`, `Firewall({ sensitive: true })` where listed, problem codes complete. | A34, S01 follow-ups |
| WP-11 | **Webhook**: verification, body cap/raw body, `WebhookIntakeService` (inbox claim + job in one transaction), `WebhookProcessorService` (result states, status check, mismatch, late success → refund command once, failed/refund handling), policy `orders.webhook.ip`; `@SkipThrottle` deleted; `payment-webhook.e2e-spec.ts`. | AS-41–AS-49, AS-51, AS-52; A16–A22; S50, S53 follow-ups |
| WP-12 | **`payments.events` consumer** on the S53 framework (envelope check, zod, inbox `recordOnce`, DLQ), shared transitions with the webhook; `payment-events.e2e-spec.ts`. | AS-50; A23, A43 |
| WP-13 | **Boundary clean-up and barrel**: remove foreign model imports from `orders.module.ts`, controllers and flash controller (replace by R1), flash files parked in `infra/flash/` + `FlashSaleLegacyModule` (raw `Product` SQL → `applyStockDelta` with `orders:flash:<saleId>:load|return`), `OrderService` compat shrink, `index.ts` rewritten with the transitional block, importer adaptations for the event field renames, `orders-boundary.e2e-spec.ts` (AS-68); item-title backfill job. | AS-68; A32, A33, A38, A39, A43; D-7, D-8, D-11, D-12, D-15, D-17; section C |
| WP-14 | **Whole-capability run**: all eight specs + unit specs + `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership` (record 12 → remainder), `check:no-wallclock`, importer suites from WP-0; record the green run (VII.9); fill `UNVERIFIED.md` rows; write the report. | all |

## Gap coverage

| Gaps | Package | | Gaps | Package |
|---|---|---|---|---|
| A1, A2, A3 | WP-6 | | A24, A25 | WP-8 |
| A4, A9, A10, A12, A14 | WP-4, WP-6 | | A26 | WP-5, WP-8, WP-13 |
| A5, A6, A7, A8 | WP-7 | | A27, A28 | WP-5 |
| A11, A36 | WP-1 | | A29, A30, A31 | WP-3 |
| A13 | WP-6, WP-7 | | A32, A33, A39 | WP-4, WP-13 |
| A15 | WP-2, WP-5, WP-8 | | A34 | WP-10 |
| A16, A17, A18, A19, A20, A21, A22 | WP-11 | | A35 | WP-1 |
| A23, A43 | WP-12, WP-13 | | A37 | WP-2 (+ data-model migrations) |
| A38 | WP-13 (parked for S11) | | A40, A41 | WP-3…WP-12 (per file), WP-2 (units) |
| A42 | WP-9 | | B: D-6 → WP-4; D-7 → WP-13; D-8 → WP-13; D-10 → not paid (S12); D-11 → WP-2, WP-13; D-12 → WP-13 (C table); D-15 → WP-13; D-17 → WP-2 | |
| C rows 1–12 | Rows 1, 3, 6, 7, 8, 9, 10, 11, 12 → WP-13 / WP-7 / WP-2; row 2 (`order-export`) → S12 (CT-2); row 4 (flash jobs) → WP-13 minimal replacement (D-9) | | D1…D9, E | D1/D2/D3/D4/D5/D6/D7 are consumed (built, or ports for S13/S45); D8 → WP-1; D9 → WP-13 (registry unchanged, verified); E → data-model + WP-2/WP-13 |

## Success-criteria proof

| SC | Proof |
|---|---|
| SC-001 | `checkout-stock.e2e-spec.ts` 200/50 race (AS-32), repeated 5× in the spec; the 50-repeat statistic is an Ops artifact |
| SC-002 | AS-15, AS-17 (5 parallel), AS-20, replay after `PAID` |
| SC-003 | **Not proven by an automated test** (p99 under load) → Ops artifacts + `UNVERIFIED.md` |
| SC-004 | "no relational access" proven by AS-01 (no SQL on the connection during cart calls); the 99%-under-50 ms latency part → Ops artifacts + `UNVERIFIED.md` |
| SC-005 | forged/stale/altered refused and duplicates inert: AS-42, AS-43, AS-53; the "99% acknowledged under 1 s" latency part → Ops artifacts + `UNVERIFIED.md` |
| SC-006 | AS-36, AS-37, AS-39 with a frozen clock at +16 min |
| SC-007 | `money-allocation.spec.ts` `fast-check` 10,000 cases (AS-25) |
| SC-008 | AS-40, AS-55, AS-58, AS-61, AS-63 matrix with byte-identical `404` |
| SC-009 | AS-47, AS-51 |
| SC-010 | AS-68 / `orders-boundary.e2e-spec.ts` proves every finding except the S12 `order-export` join is gone; the literal "0 findings" is an Ops artifact + `UNVERIFIED.md` row until S12 |

## Re-check after Phase 1

Design artifacts re-read against the gates: (1) layers hold — the only non-conforming code is the explicitly parked legacy (CT-1, CT-3); (2) controllers map DTOs only; (3) the saga keeps three short transactions and no I/O inside; (4) every new column is nullable-or-defaulted in expand; (5) events and consumer follow S53; (6) schemas listed for every route; (8) test rows exist for every scenario; (10) no new table, no foreign association left in the owned models. **No gate fails; two named exceptions plus one transitional remainder are in Complexity Tracking.**

**Risks**: R-1 the idempotency fingerprint for an empty body (D-3) — checked first in WP-6. R-2 renamed event fields break seven in-repo importers (WP-13 adapts field reads; their suites run in WP-14). R-3 `payments.events` has no producer until S13 (consumer tested with injected messages; the webhook path is the live one). R-4 the `PaymentStatusPort` default fails closed, so in a deployment without S13 every webhook ends `FAILED` after 8 attempts and the hold expires — safe, but payments cannot complete until S13 binds the adapter (follow-up). R-5 DynamoDB transaction limit of 100 operations per merge (50 + 50) is exactly at the cap; the 50-line cap on both carts keeps it there.

## Complexity Tracking

| # | Rule | Why it cannot be met now | Simpler alternative rejected | Removal date |
|---|---|---|---|---|
| CT-1 | X.4 / IX.4 (barrel exports models and infra classes) | Seven capabilities still import `BisOrderModel`, `OrderService`, `FlashStockService`, `OrderExportService`, `CheckoutDiscounts`, the legacy event classes and `CreateBisOrderDto`; deleting the exports breaks their build, and those specs belong to them | Deleting the exports now (breaks S12, S13, S16, S21, S31, S42, S43 builds); duplicating the classes (two owners of one table) | each line leaves when its last importer converts; whole block gone by **2027-01-31** (pinned: the list can only shrink) |
| CT-2 | IX.4 (raw `Product` join in `application/order-export.service.ts:69`) | Belongs to S12 (debt D-10); S10 does not touch the export | Rewriting the export here (steals S12's scope and changes `catalog-sync`) | with S12, **2026-12-31** |
| CT-3 | I.2 / IX.4 for the parked flash-sale code (`infra/flash/`, `FlashSaleLegacyModule`) | S11 owns flash sales; deleting it now removes working behaviour with no replacement | Deleting it (S11 starts from nothing); keeping it in checkout (violates the seam) | with S11, **2026-12-31** |
