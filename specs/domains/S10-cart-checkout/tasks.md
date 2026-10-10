# Tasks: S10 — Cart, Checkout, Stock Reservation, Order State Machine, Payment Webhook (domain `orders`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `research.md`, `data-model.md`, `contracts/{http,services,events}.md`, `quickstart.md`. Constitution v3.1.0.

**Tests**: REQUESTED (test-plan.md, 68 rows, VII.8). Order is test-first: for each test-plan row the failing test task comes before the code task that makes it pass. A test task is done when it is written and **fails for the right reason**; the code task is done when it passes.

**Paths**: `D = packages/backend/libs/domains/orders`, `C = packages/contracts/src/orders`, `M = packages/backend/migrations`. Run backend commands from `packages/backend`. Runner: `S=/opt/sdd/repo/scripts/sdd/test-spec.sh`; narrowest test per task, the whole capability once in Phase 10. If the same test still fails after 5 fix attempts: stop and write blocker, attempts and hypothesis into `questions.md`.

**Rules that apply to every task**: no `git checkout/restore/reset/stash/clean` (undo by hand-editing only the lines named); no new direct `sequelize.transaction` (use `TransactionRunner.run` / `@Transactional`); no network I/O inside a transaction; time only through `Clock`/`CLOCK`; do not edit other capabilities' specs (follow-ups go under `## Sibling-spec follow-ups` in `gaps.md`, already written by plan); never describe an unverified SC as verified.

**Format**: `- [ ] Tnnn [P?] [USn?] description + path`. `[P]` = different files, no dependency on an unfinished task.

## User stories

| Story | Priority | Scenarios |
|---|---|---|
| US1 Cart (guest, signed-in, merge) | P1 | AS-01…AS-12 |
| US2 Idempotent checkout, pricing, split | P1 | AS-13…AS-30 |
| US3 Stock never oversold, always returned | P1 | AS-31…AS-40 |
| US4 Signed webhook marks paid | P1 | AS-41…AS-53 |
| US5 State machine, cancel, fulfilment | P2 | AS-54…AS-57 (+AS-40, AS-55) |
| US6 Reads, history, seller list, exported reads | P2 | AS-58…AS-63 |
| US7 Events, observability, jobs, boundaries | P3 | AS-64…AS-68 |

---

## Phase 1: Setup and baseline (WP-0)

- [X] T001 Record baselines in `specs/domains/S10-cart-checkout/.ownership.baseline` and `.tx.baseline` (already present: confirm contents are `check:table-ownership` = 12 findings for `orders` and direct `sequelize.transaction` count = 1 at `D/infra/order.jobs.ts:125`); do not overwrite if correct.
- [X] T002 Run the currently green suites to know what must stay green: `$S libs/domains/orders` and importers `libs/domains/{catalog-sync,auctions,notifications,experimentation,developer-platform,discovery,seller-insights,payments,shop-functions,asset-library}` and `libs/infrastructure/rate-limit`; note failing-before results at the top of `research.md` "Baseline" (append only).
- [X] T003 Verify the assumptions of WP-0 and write findings into `research.md`: DynamoDB Local supports `TransactWriteItems`; `InboxService.claim/markStatus/purge` signatures; idempotency fingerprint of "no body" equals `{}` (D-3, risk R-1). If "no body" ≠ `{}`, add a `gaps.md` Sibling-spec follow-up for **S54** and normalise in the checkout controller.

---

## Phase 2: Foundational (WP-1, WP-2, WP-4, WP-5) — blocks all stories

**Purpose**: contracts, config, pure domain, models/migrations, ports/adapters, single state writer. No user story starts before this checkpoint.

### Contracts and config (WP-1; A11, A35, A36; D7, D8)

- [X] T004 [P] Create zod schemas in `C/cart.ts` (`cartSchema`, `setCartLineRequestSchema` quantity int 1..20 / 0 removes), `C/checkout.ts` (`checkoutRequestSchema` = `{expectedTotalMinor?: int ≥ 0}` `.strict()`, `checkoutResponseSchema` = `{orderId,status,totalMinor,currency,reservedUntil}`), `C/order.ts` (`orderSchema`, `orderListItemSchema`, `orderPageSchema`, `shopOrderPageSchema`), `C/webhook.ts` (`webhookAckSchema`), `C/index.ts`; export from `packages/contracts/src/index.ts`; shapes per `contracts/http.md`.
- [X] T005 [P] Create `C/order-events.ts` (`orderEventSchemas`: `order.reserved|paid|cancelled|refunded|fulfilment_changed` with `…Minor` fields, `shopOrders`, `title`, `orderVersion`, `previousStatus` on cancelled, `refundRequestedSchema`) and `C/payment-events.ts` (`paymentEventSchemas`: `payments.payment_succeeded|payment_failed|payment_refunded` v1) per `contracts/events.md`.
- [X] T006 Add validated config keys (startup fails when missing/invalid): `cart_cookie_secret` (≥ 32 bytes, must differ from `jwt_secret`), `stripe_webhook_secret`, optional `stripe_webhook_secret_previous`, hold 15 min, line limits 50/20, cart lifetime 30 d, sweeper 60 s/200, recovery age 60 s, timeouts (catalog 1 s, stock 2 s, discounts 250 ms, shops 1 s, status 2 s, cart Dynamo 500 ms, lock 100 ms, whole checkout 10 s) in `D/orders.config.ts`; replace constants `RESERVATION_HOLD_MS`, `MAX_LINE_QUANTITY`, `TTL_SEC` (A36).
- [X] T007 [P] Create error classes with stable `code` in `D/domain/order-errors.ts` (`price_changed`, `cart_empty`, `cart_line_limit`, `product_unavailable`, `out_of_stock`, `mixed_currency`, `checkout_in_progress`, `checkout_unavailable`, `order_not_cancellable` with `currentStatus`, `InvalidOrderTransitionError`, `OrderNotFoundError`, `OrderNotPayableError`, `invalid_signature`, `invalid_payload`, idempotency codes) as `AppError` subclasses; register in the problem catalog.
- [X] T008 [P] Add rate policies to `D/rate-limit-policies.ts` via `definePolicies`: `orders.cart-write.identity` 120/min fail open, `orders.cancel.user` 20/min fail closed, `orders.webhook.ip` 300/min fail open; keep `checkout.create` 10/min fail closed; `OrdersModule` keeps `RateLimitModule.forFeature(ordersRatePolicies)`.
- [X] T009 [P] Create `D/domain/order-metrics.ts` (metric names for checkout outcomes, expiry, release backlog gauge, webhook results, cart cleanup failures, discount fallback, backfill orphans) (A42).

### Pure domain: tests first (WP-2; A15, A41)

- [X] T010 [P] Write failing `D/domain/guest-cart-token.spec.ts` (AS-11): seven token forms incl. no `.` (`lastIndexOf` = -1), constant-time compare, never throws.
- [X] T011 [P] Write failing `D/domain/cart-merge.spec.ts` (AS-12): table + `fast-check` (once per product, `min(20,u+g)`, ≤ 50 lines, user lines survive, `droppedLines`, overflow order user first then guest by `addedAt`,`productId`).
- [X] T012 [P] Write failing `D/domain/money-allocation.spec.ts` (AS-23, AS-25): `100` over `3333,3333,3334` → `33,33,34`; ties; refusal over gross; `fast-check` 10,000 carts (exact sum, ±1 proportional share, shop subtotals sum to total).
- [X] T013 [P] Write failing `D/domain/stock-operations.spec.ts` (AS-35): any order, repeated product summed, 100 products, ascending ids, operation id `orders:<orderId>:reserve|release:<productId>`.
- [X] T014 [P] Write failing `D/domain/order-state.spec.ts` (AS-54): every (status, command, reason) vs allowed list from `data-model.md`, terminals, "already applied" set (markPaid on PAID+, cancel on CANCELLED, refund on REFUNDED), exhaustive-switch type test.
- [X] T015 [P] Write failing `D/domain/webhook-signature.spec.ts` (AS-53): header forms, tolerance edges 300/301 s with injected clock, one or two secrets, constant-time, typed error.
- [X] T016 [P] Implement `D/domain/guest-cart-token.ts` (dedicated secret, HMAC, explicit `-1` handling) until T010 passes (A29).
- [X] T017 [P] Implement `D/domain/cart-merge.ts` until T011 passes.
- [X] T018 [P] Implement `D/domain/money-allocation.ts` (largest remainder, integer minor units only, validation of discount results: negative/float/over gross/unknown shop → reject) until T012 passes (A10).
- [X] T019 [P] Implement `D/domain/stock-operations.ts` until T013 passes.
- [X] T020 [P] Implement `D/domain/order-state.ts` (discriminated union, reasons, `assertNever`, "already applied" as a result not `null`) until T014 passes (A15).
- [X] T021 [P] Implement `D/domain/webhook-signature.ts` (raw body, current + previous secret, ±300 s, constant time) until T015 passes.
- [X] T022 [P] Implement `D/domain/order-cursor.ts` (opaque keyset cursor `(createdAt,id)`, invalid → typed error).
- [X] T023 Create `D/domain/ports.ts` with tokens/interfaces (order, reservation, history, shop-order repositories; cart store; checkout lock; catalog, shop directory, payment status (`PaymentStatusPort`), discounts, realtime, refund command, `ReservationSource`) (D-6, A32, A33).
- [X] T024 Run `npx jest libs/domains/orders/domain` — all six unit specs green.

### Models and migrations (WP-2; A37, D-11, D-17; E)

- [X] T025 In `D/infra/models/bis-order.model.ts` delete the `User` and `Payment` associations, their imports and the lazy `require` accessors (S01 follow-up, D-11, D-17); `userId` plain id; add `requestHash TEXT NULL`, `paymentRef TEXT NULL`, `version INTEGER NOT NULL DEFAULT 1`, `cancelReason TEXT NULL` (`out_of_stock | payment_failed | hold_expired | user_cancelled`).
- [X] T026 In `D/infra/models/bis-order-item.model.ts` delete `ProductModel` and `BelongsTo(Product)` (S05 follow-up), keep one-way association item → order; add `title TEXT NULL`, `discountMinor BIGINT NOT NULL DEFAULT 0`, `lineTotalMinor BIGINT NULL`; `productId` plain UUID, no FK.
- [X] T027 [P] Update `D/infra/models/` for `ShopOrder` (`shopId` NOT NULL after backfill, `status` in `PENDING | PAID | CANCELLED | REFUNDED`), `OrderEvent` (`actor TEXT NULL`, `amountMinor BIGINT NULL`), `StockReservation` (status adds `REQUESTED`, `RELEASE_PENDING`; `source TEXT NOT NULL DEFAULT 'CATALOG'`, `sourceRef TEXT NULL`, `releaseAttempts INTEGER DEFAULT 0`, `nextReleaseAt TIMESTAMPTZ NULL`).
- [X] T028 Slim `ORDER_MODELS` in `D/orders.module.ts`: remove `Product` and `Payment` (plan C rows).
- [X] T029 Create `M/20261010000001-orders-s10-expand-columns.js` (`SET lock_timeout`, all new columns of T025–T027, `CHECK` on `BisOrder.status`/`ShopOrder.status`/`StockReservation.status` added `NOT VALID`).
- [X] T030 Create `M/20261010000002-orders-s10-expand-indexes.js` (`transaction: false`, `CREATE INDEX CONCURRENTLY`): history `(userId, createdAt DESC, id DESC) INCLUDE (status,total,currency) WHERE NOT (status='CANCELLED' AND "cancelReason"='out_of_stock')` replacing the old one; partial `(reservedUntil) WHERE status='RESERVED'`; partial `(createdAt) WHERE status='PENDING'`; `ShopOrder (shopId, createdAt DESC, id DESC)`; `OrderEvent (orderId, createdAt, id)`; partial `(nextReleaseAt) WHERE status='RELEASE_PENDING'`; unique `(bisOrderId, shopId)` on `ShopOrder` and `(bisOrderId, productId)` on `StockReservation` concurrently then attached.
- [X] T031 Create `M/20261010000003-orders-s10-validate.js` (`VALIDATE CONSTRAINT` for the three `CHECK`s). Do NOT write the contract migration in this change.
- [X] T032 Apply with `pnpm test:stack:migrate`; run `pnpm check:model-registry`; `db/ownership.ts` needs no new table (D9) — confirm and note in `research.md`.

### Ports, adapters, repositories (WP-4; A4, A9, A14, A32, A33; D-6)

- [X] T033 [P] Implement `D/infra/order.repository.ts`, `reservation.repository.ts`, `order-history.repository.ts`, `shop-order.repository.ts` returning plain records (safe-integer check on BIGINT at the edge); every read/write scoped by principal where the contract says so (`WHERE id=:id AND "userId"=:u`).
- [X] T034 [P] Implement `D/infra/catalog.adapter.ts` (`ProductQueryService.getProductsByIds`, 1 s timeout, maps missing/archived/sandbox) and `D/infra/shop-directory.adapter.ts` (`ShopQueryService.getShopsByIds` with `status`, `isSandbox`, 1 s, ≤ 50 shops).
- [X] T035 [P] Implement `D/infra/payment-status.adapter.ts` (`PaymentStatusUnavailableAdapter` fail-closed default, 2 s) and `D/infra/discounts.adapter.ts` (`LegacyCheckoutDiscountsAdapter` converting old per-line result to shop amounts; 250 ms; validates; fallback metric + warning without payload) (A9).
- [X] T036 [P] Implement `D/infra/realtime.adapter.ts` (best effort, failure logged + counted, A28), `D/infra/refund-command.adapter.ts` (SQS `orders.refund_requested`), `D/infra/checkout-lock.redis.ts` (`orders:checkout-lock:<userId>`, token, `PX 15000`, 100 ms), `D/infra/catalog-reservation-source.ts` (`ReservationSource` over `ProductStockService.applyStockDelta`; archived/`unavailable` → product_unavailable, `insufficient` → out_of_stock).
- [X] T037 [P] Implement `D/infra/cart.dynamo-store.ts` (`PK=CART#<id>`, `SK=ITEM#<productId>` with `productId, quantity, addedAt, expiresAt`; `SK=META` `lineCount` conditional cap 50; expired lines filtered on read; `TransactWriteItems` atomic idempotent merge; 500 ms timeout) (A30, A13).
- [X] T038 Wire adapters to tokens in `D/orders.module.ts` and `D/orders-worker.module.ts`; remove `OrderStateModule` duplication in the worker module (A39, D-8).

### Single state writer: test first (WP-5; A15, A27, A28)

- [X] T039 Create the e2e kit `D/testing/orders-app.ts`: real `OrdersModule` + `OrdersWorkerModule` handlers, prod prefix/`ValidationPipe`/problem+json filter, **`RateLimitModule.forRoot()`** (S01/S50 follow-up) so 429 is real, identity session fixture from `identity/testing/auth-app.ts` (replaces `issueTokensFor`), seed helpers using only `ProductQueryService`/`ProductStockService`/`ShopQueryService`, fakes only at edges (payment status, discounts, signatures with real scheme, realtime transport, frozen clock), fault gates (latch in stock call, store rule refusing one cart write/release/outbox append, delayed catalog read, limiter store off).
- [X] T040 Write failing `D/order-lifecycle.e2e-spec.ts` (describe "Orders: state machine, cancel and fulfilment commands") for AS-56 (one history row + one version step per move through `DELIVERED`; 20 concurrent copies of one move → one applies) and AS-57 (`OrderFulfilmentService.apply` `startFulfilment|ship|deliver` with `order.fulfilment_changed`; illegal → `InvalidOrderTransitionError`; unknown → `OrderNotFoundError`).
- [X] T041 Define the five events with `defineEvent` in `D/application/events/order-events.ts` on the contracts schemas (T005), register in `TopicRegistry` for `orders.events`.
- [X] T042 Implement `D/application/order-lifecycle.service.ts` `transition`: conditional `UPDATE … WHERE id AND status=:from`, `version+1`, `OrderEvent` row with `actor`, `OutboxService.append`, shop-order and reservation propagation — all in one `TransactionRunner.run`; realtime push after commit; "already applied" returns result not `null`.
- [X] T043 Implement `D/application/order-fulfilment.service.ts` (`apply(orderId, {type})`), export from barrel later (T139); run `$S libs/domains/orders/order-lifecycle -t "history|fulfilment"` until T040 is green.

**Checkpoint**: contracts, pure domain, models, ports and the single writer exist; stories can start.

---

## Phase 3: US1 — Cart (P1) 🎯 MVP (WP-3; A29, A30, A31, A40; AS-01…AS-10)

**Goal**: guest and signed-in cart without relational access; atomic idempotent merge; limits; expiry.
**Independent test**: `$S libs/domains/orders/cart`.

- [X] T044 [US1] Rewrite `D/cart.e2e-spec.ts` (describe "Cart: guest, signed-in, merge and limits"), failing first, all through HTTP + session fixture (no `issueTokensFor`): AS-01 (empty GET with no `Set-Cookie`; PUT issues cookie with all attributes; one `guest:<uuid>` cart; zero SQL on the connection), AS-02, AS-03 (2 then 5, 0 removes, validation classes `400`, 51st line `422 cart_line_limit`, existing line writable at 50), AS-04 (five bad cookies on GET/PUT/merge, no lookup of claimed id, new cookie only on PUT), AS-05 (`{A:4,B:20,C:2}`, guest cart gone, cookie cleared), AS-06 (`Promise.all` two merges), AS-07 (40+20 → 50, `droppedLines: 10`), AS-08 (`401`, signed-in no cookie `200`), AS-09 (frozen clock +30 d +1 s hidden, re-set restarts), AS-10 (121st write `429` `Retry-After`, reads unaffected).
- [X] T045 [US1] Implement `D/application/cart.service.ts` using the store port and `domain/cart-merge.ts` (set semantics, clamp as `400`, `addedAt` kept, merge → `{lines, droppedLines}`, clear only lines read).
- [X] T046 [US1] Implement `D/api/cart.controller.ts` + `D/api/cart-cookie.ts` + DTO: `GET /cart` (no cookie issued), `PUT /cart/items/:id` (`@RateLimit('orders.cart-write.identity')`, anonymous allowed), `POST /cart/merge` (session required, answers `200`); `AuthenticatedUser` replaces `@User()`/`UserRawDto` (A34); no `jwt_secret` fallback; DTO imports nothing from `infra` (A32).
- [X] T047 [US1] Run `$S libs/domains/orders/cart` until T044 is green.

**Checkpoint**: US1 independently shippable.

---

## Phase 4: US2 — Idempotent checkout, pricing, split (P1) (WP-6; A1–A4, A9–A14; AS-13…AS-30)

**Independent test**: `$S libs/domains/orders/checkout.e2e` (stock failures and expiry belong to US3).

- [X] T048 [US2] Rewrite `D/checkout.e2e-spec.ts` (describe "Checkout: idempotency, validation, pricing and split"), failing first, HTTP only, session fixture, no model injection: AS-13, 14, 15, 16 (latch in stock call → `409 idempotency_in_flight` + `Retry-After: 1`), 17 (`Promise.all` ×5), 18 (reuse other body / no body `422 idempotency_key_reuse`; missing `…_required`; 5, 129 chars, space `…_invalid`), 19, 20, 21 (`401`, `cart_empty`, `product_unavailable` listing all ids for missing/archived/sandbox/non-active shop, `mixed_currency`), 22, 24, 26 (11th `429`; limiter store off → refused), 27, 28, 29, 30 (slow product read → `503 checkout_unavailable`, key unused; slow stock → `PENDING`, retry `409` until recovery).
- [X] T049 [US2] Implement `D/application/checkout.service.ts` phase A: Redis lock (`checkout_in_progress`), cart read, `getProductsByIds` + shop status, currency from products (no `EUR` default), `product_unavailable`/`mixed_currency`, discounts via port + `money-allocation`, `expectedTotalMinor` check → `409 price_changed`, 10 s budget with per-call timeouts → `503 checkout_unavailable`; injected `Clock` for `reservedUntil` (A11).
- [X] T050 [US2] Implement checkout Tx 1 (one `TransactionRunner.run`): order `PENDING` with `idempotencyKey` + `requestHash` (the durable guard, D-3), items (title, unit price, `discountMinor`, `lineTotalMinor`, `shopId`), shop orders (one per shop, subtotals), reservations `REQUESTED`, history row; unique `(userId, idempotencyKey)` conflict resolved by fingerprint compare.
- [X] T051 [US2] Implement `D/api/checkout.controller.ts`: `POST /checkout` `@Idempotent()` (S54), `Firewall({ sensitive: true })` (no `SessionNotRevokedGuard`), `@RateLimit('checkout.create')`, strict body DTO from `checkoutRequestSchema`, `202` + `Location: /orders/<id>` + `checkoutResponseSchema`, `Idempotency-Replayed` on replay; pre-order failures release the key, post-order `out_of_stock` stored via `AppError.idempotencyFinal` (A1–A3).
- [X] T052 [US2] Implement cart consumption: after success remove exactly the lines/quantities read (conditional delete), failure → warning + job `orders.clear-cart` (T068), metric (A13).
- [X] T053 [US2] Run `$S libs/domains/orders/checkout.e2e` — green for AS-13…AS-30 except rows that need reservation outcome (those are asserted via the stub in T049–T050 and finalised in Phase 5; rerun after T063).

**Checkpoint**: checkout accepts, prices, splits and replays.

---

## Phase 5: US3 — Stock never oversold, always returned (P1) (WP-7; A5–A8, A13; AS-31…AS-40)

**Independent test**: `$S libs/domains/orders/checkout-stock`.

- [X] T054 [US3] Write failing `D/checkout-stock.e2e-spec.ts` (describe "Checkout: stock reservation, expiry and compensation"): AS-31 (operation `orders:<id>:reserve:A` delta `-3`, replay no effect, no product-table query), AS-32 (200 HTTP checkouts on 50 units → 50 `202`, 150 `422 out_of_stock`, stock 0; loop 5×), AS-33, AS-34 (100+100 opposite order, no `5xx`), AS-36, AS-37, AS-38, AS-39, AS-40 (buyer cancel `200`, stock back once, other user `404`); archived product refuses negative delta → `422 product_unavailable`.
- [X] T055 [US3] Implement saga step in `checkout.service.ts`: one `ProductStockService.applyStockDelta` call outside any transaction using `stock-operations` (sorted ids, `operationId` form, reason `order.reserve`), map `insufficient` → `422 out_of_stock` listing ids, `unavailable` → `product_unavailable`; Tx 2 `PENDING → RESERVED` via `OrderLifecycleService` (reservations `HELD`, `reservedUntil`, outbox `order.reserved`, realtime) and schedule the delayed expiry job outside the transaction; failure → `CANCELLED(out_of_stock)` without events/reservations.
- [X] T056 [US3] Implement `D/application/reservation-recovery.service.ts` + jobs in `D/infra/order.jobs.ts`: `orders.expire-reservation` (per order, no-op before deadline, `hold_expired`, idempotent), `orders.sweep-expired` (60 s, ≤ 200, `fleetConcurrency: 1`, skips unexpired), `orders.recover-pending` (30 s, age > 60 s, ≤ 100, re-applies the same operation ids, → `RESERVED` or `CANCELLED(out_of_stock)`).
- [X] T057 [US3] Implement release: cancel moves reservations `HELD → RELEASE_PENDING`; job `orders.release-reservations` (≤ 100 rows, `releaseAttempts`, `nextReleaseAt` backoff) calls `applyStockDelta` with `orders:<id>:release:<productId>` (compensation is a new operation), → `RELEASED`; gauge of pending (A6).
- [X] T058 [US3] Implement `D/application/order-cancellation.service.ts` + `D/api/orders.controller.ts` `POST /orders/:id/cancel` (scoped update, no get-first; `Firewall({ sensitive: true })`; `@RateLimit('orders.cancel.user')`; `409 order_not_cancellable` + `currentStatus`; `CANCELLED` → `200` no-op) (A25).
- [X] T059 [US3] Run `$S libs/domains/orders/checkout-stock` until green; then rerun `$S libs/domains/orders/checkout.e2e`.

**Checkpoint**: P1 checkout path complete.

---

## Phase 6: US4 — Signed webhook marks paid (P1) (WP-11, WP-12; A16–A23; AS-41…AS-53)

**Independent test**: `$S libs/domains/orders/payment-webhook` and `…/payment-events`.

- [X] T060 [US4] Write failing `D/payment-webhook.e2e-spec.ts` (describe "Payment webhook: signature, dedupe, async processing and out-of-order events"): AS-41, 42 (seven bad forms → `400 invalid_signature`, nothing stored; exactly 300 s accepted), 43 (`Promise.all` ×10), 44 (status unavailable → backoff retries then `PAID` once; 8 failures → inbox `FAILED`, dead letter, metric, order `RESERVED`), 45, 46, 47 (late success → stays `CANCELLED`, exactly one `orders.refund_requested`, none on repeat), 48, 49, 51 (cancel vs success ×50), 52 (64 KiB+ `413`, non-JSON `400 invalid_payload`, previous secret, other secret refused, `GET` `405`, 301 forged → `429`).
- [X] T061 [US4] Write failing `D/payment-events.e2e-spec.ts` (describe "Orders: payment result consumer"): AS-50 (message twice → one transition; four invalid payloads dead-lettered; race with webhook → one `PAID`, one `order.paid`; failed/refunded follow AS-48/49).
- [X] T062 [US4] Implement `D/application/webhook-intake.service.ts`: signature (T021) over raw body, 64 KiB cap, `InboxService.claim('stripe', eventId)` + `orders.process-webhook` job insert in one `TransactionRunner.run`, `200 {received:true, duplicate?}` before processing (replaces raw SQL on `ProcessedWebhookEvent`, A22, S53 follow-up).
- [X] T063 [US4] Implement `D/api/stripe-webhook.controller.ts`: raw body, `GET` → `405`, `@RateLimit('orders.webhook.ip')` replacing `@SkipThrottle()` (S50 follow-up), no `PaymentModel`, no logging of body/signature; error bodies `invalid_signature` / `invalid_payload` / `413`.
- [X] T064 [US4] Implement `D/application/webhook-processor.service.ts` and `payment-result.service.ts` + job handler `orders.process-webhook` (8 attempts, backoff 5 s × 2ⁿ cap 10 min full jitter): order from intent metadata `orderId`; payment confirmed via `PaymentStatusPort`; amount/currency compare → `REJECTED`; unmatched → `UNMATCHED`; unhandled type → `IGNORED`; `InboxService.markStatus` for `PROCESSED|REJECTED|UNMATCHED|IGNORED|FAILED`; success → `markPaid` (reservations `CONVERTED`, shop orders `PAID`, `paymentRef`); late success → `orders.refund_requested` once; failed → `cancel(payment_failed)`; refund full → `REFUNDED`, partial → history row `partial_refund`; refund before success retried.
- [X] T065 [US4] Implement `D/infra/payments-events.consumer.ts` on the S53 framework (envelope fields adopted, zod `paymentEventSchemas`, inbox `recordOnce`, DLQ, no `continue` on malformed) replacing `order-payment.listener.ts`; shares transitions with T064 (A23, A43); legacy orders without `idempotencyKey` follow the machine.
- [X] T066 [US4] Run `$S libs/domains/orders/payment-webhook` and `…/payment-events` until green.

**Checkpoint**: payment path complete (live path fails closed until S13).

---

## Phase 7: US5 — State machine, cancel, fulfilment (P2) (AS-54…AS-57)

**Independent test**: `$S libs/domains/orders/order-lifecycle`.

- [ ] T067 [US5] Extend `D/order-lifecycle.e2e-spec.ts` with failing AS-55 (cancel on `PAID`/`FULFILLING`/`SHIPPED`/`DELIVERED`/`REFUNDED` → `409` + `currentStatus`; `CANCELLED` → `200` unchanged; unknown/other's `404` byte-identical; bad id `400`; `401`) and the 50-run pay-vs-cancel race hook shared with AS-51.
- [ ] T068 [US5] Make T067 green (T058 already routes cancel); also register job `orders.clear-cart` and `orders.cleanup-cart` handlers in `D/infra/order.jobs.ts` (cart cleanup retry, AS-29).
- [ ] T069 [US5] Run `$S libs/domains/orders/order-lifecycle` — AS-40, AS-54…AS-57 green.

---

## Phase 8: US6 — Reads, history, seller list (P2) (WP-8; A24–A26; AS-58…AS-63)

**Independent test**: `$S libs/domains/orders/order-read`.

- [ ] T070 [US6] Write failing `D/order-read.e2e-spec.ts` (describe "Orders: reads, history and tenant isolation"): AS-58 (owner body with timeline parsed by `orderSchema`; other buyer, shop member, admin → `404` byte-identical to missing; `401`; `400`), AS-59 (45 orders same instants pages 20/20/5, no repeat/skip under concurrent inserts, hidden `out_of_stock`, default and max limit, bad limit/cursor `400`), AS-60 (10,000 orders, `VACUUM`, `EXPLAIN` index-only, no sort), AS-61 (all roles of `S1` `200` only `S1` slice; `S2`-only/non-member `404`; anonymous `401`; non-active shop per S03 gate; bad `status`/cursor `400`), AS-62, AS-63.
- [ ] T071 [US6] Implement `D/application/order-query.service.ts` (`getOrdersForShop`, `getOrderLines` one statement ≤ 500 ids, 501 throws, `getPayableOrder` → `OrderNotPayableError`/`OrderNotFoundError`; DTOs only, no models) and `order-history.repository.ts` keyset query.
- [ ] T072 [US6] Implement in `D/api/orders.controller.ts` `GET /orders` (`limit`, `cursor`) and `GET /orders/:id` (principal-scoped, no persistence fields); create `D/api/shop-orders.controller.ts` `GET /shops/:shopId/orders` with `ShopScoped('orders.read')`.
- [ ] T073 [US6] Run `$S libs/domains/orders/order-read` until green.

---

## Phase 9: US7 — Events, observability, jobs, boundaries (P3) (WP-9, WP-13; A38, A39, A42; D-7, D-8, D-12, D-15; AS-64…AS-68)

**Independent test**: `$S libs/domains/orders/order-events`, `…/orders-boundary`.

- [ ] T074 [US7] Write failing `D/order-events.e2e-spec.ts` (describe "Orders: events, realtime, observability and jobs"): AS-64 (one outbox row per transition with envelope + `orderVersion` parsed by `orderEventSchemas`; append failure → rollback + `503`), AS-65 (hub down), AS-66 (logs carry `requestId`/`traceId`/`orderId`, none of body, signature, secret, cookie, authorization, key; metrics exist), AS-67 (each job twice and on two instances → one effect; inbox purge at 35 d + 1 s removes, 35 d keeps, only webhook rows).
- [ ] T075 [US7] Register all 8 job types in `D/orders-worker.module.ts` with `declareJobType`, schedules, single-run: expiry, sweeper, recover-pending, release, clear-cart, process-webhook, inbox purge (35 d, ≤ 1,000), `orders.backfill-item-titles` (batches of 200, `"(removed product)"`, `lineTotalMinor = priceAtPurchase × quantity`, `orders_backfill_orphans` gauge, resumable).
- [ ] T076 [US7] Rewrite `D/infra/order.jobs.ts` on `TransactionRunner.run`: migrate the direct `sequelize.transaction` at `:125` and delete its `// S54 T037 audit` comment (count 1 → 0); remove flash handlers from it (moved in T078).
- [ ] T077 [US7] Add metrics and structured logs per T009 across services (A42); verify T074 green with `$S libs/domains/orders/order-events`.
- [ ] T078 [US7] Park flash-sale code in `D/infra/flash/` (`flash-stock.service.ts` + spec, `flash-sale.model.ts`, `flash-sale.jobs.ts`, `flash-sale.controller.ts`) + `D/flash-sale-legacy.module.ts`; replace its raw `Product` SQL with `applyStockDelta` (`orders:flash:<saleId>:load|return`) and its `ProductModel` use with `getProductsByIds(ids,{shopId})`; remove the flash branch from checkout behind `ReservationSource` (A38, D-9).
- [ ] T079 [US7] Compat shrink of `D/application/order.service.ts` (same constructor for `auctions-worker.module.ts`, delegates to `OrderLifecycleService`); no `infra` imports from `api/` or `application/` (A32, A33, D-6).
- [ ] T080 [US7] Rewrite `D/index.ts`: export `OrderQueryService`, `OrderFulfilmentService`, DTO types, errors, event definitions; keep a clearly marked TRANSITIONAL block (`BisOrderModel`, `BisOrderItemModel`, `ShopOrderModel`, `StockReservationModel`, `FlashSaleModel`, `OrderService`, `FlashStockService`, `OrderExportService`, `CheckoutDiscounts`, legacy event classes, `CreateBisOrderDto`) with removal dates per CT-1 (D-7, D-8).
- [ ] T081 [US7] Adapt in-repo importers minimally (field reads only) for the event renames in `catalog-sync`, `notifications`, `experimentation`, `discovery`, `seller-insights`, `shop-functions`, `developer-platform` (`total`→`totalMinor`, `price`→`unitPriceMinor`, `paymentId`→`paymentRef`, `shopOrders`, `previousStatus`); do not edit their specs' prose.
- [ ] T082 [US7] Write `D/orders-boundary.e2e-spec.ts` (AS-68): `check:table-ownership --strict` yields only the S12 `order-export.service.ts` `Product` join for `orders` (12 → 1); `check:boundaries` green; barrel exports no `*Model` outside the TRANSITIONAL block; no association to foreign models; ownership registry complete; zero `sequelize.transaction`/`S54 T037 audit` in `D/`; no `SessionNotRevokedGuard`, `@SkipThrottle`, `throttle`/`skipThrottle` args in the domain.
- [ ] T083 [US7] Run `$S libs/domains/orders/orders-boundary` until green.

---

## Phase 10: Polish, whole-capability run, gap closure (WP-14)

- [ ] T084 Delete obsolete files (`order-payment.listener.ts`, old `cart.repository.ts`, `checkout-discounts.port.ts` if superseded) and every `issueTokensFor` use in the domain.
- [ ] T085 [P] Static gates from `packages/backend`: `npx tsc --noEmit -p tsconfig.json`, `npx eslint libs/domains/orders`, `pnpm check:boundaries`, `pnpm check:table-ownership` (record output; expect only the S12 remainder), `pnpm check:no-wallclock`, `pnpm check:model-registry`; `(cd ../contracts && npx tsc --noEmit)`; direct-transaction count in `libs/domains/orders` = 0 (baseline 1 in `.tx.baseline`).
- [ ] T086 Run the whole capability once: `$S libs/domains/orders` and `npx jest libs/domains/orders/domain`; then importer suites from T002 and `libs/infrastructure/rate-limit`; fix regressions (5-attempt rule).
- [ ] T087 Gap audit: walk `gaps.md` A1–A43, B (D-6, D-7, D-8, D-10 not paid/S12, D-11, D-12, D-15, D-17), C rows 1–12 (row 2 → S12/CT-2, row 4 flash minimal replacement), D1–D9, E; each is closed by a named task above or recorded as a remainder in `research.md`. Mapping: A1–A4,A9–A14 → T049–T052; A5–A8 → T055–T057; A15 → T020,T042; A16–A23 → T062–T065; A24–A26 → T071–T072,T058; A27,A28 → T041–T042,T036; A29–A31 → T016,T037,T046,T008; A32–A34 → T023,T033,T046,T079; A35,A36 → T004–T006; A37 → T025–T031; A38 → T078; A39 → T038; A40 → T044,T048 and later test tasks; A41 → T010–T015; A42 → T009,T077; A43 → T065,T075.
- [ ] T088 Confirm each follow-up from built specs is met and list it in the final report: S01 (T025 `User` dropped; T039 `RateLimitModule.forRoot()`; T044/T048 session fixture; T051/T058 `Firewall({sensitive:true})`), S05 (T034/T036/T055/T057/T026/T054), S50 (T063, `@RateLimit` metadata + forRoot in kit), S53 (T062, T065).
- [ ] T089 Verify `specs/UNVERIFIED.md` rows for S10 SC-001, SC-003, SC-004 (latency), SC-005 (latency), SC-010 (present, status `not run`) match `quickstart.md` "Ops artifacts"; add any other SC no test proves (none expected: SC-002, 006, 007, 008, 009 are proven by AS-15/17/20, AS-36/37/39, AS-25, AS-40/55/58/61/63, AS-47/51). Never mark them verified.
- [ ] T090 Record the green run (VII.9) in `quickstart.md` under a "Recorded run" heading (date, commands, counts) and check `Sibling-spec follow-ups` in `gaps.md` still match shipped names/shapes; edit only that section if not.

---

## Dependencies and execution order

- Phase 1 → Phase 2 (blocks all) → stories. Within Phase 2: T004–T009 ∥; T010–T015 (tests) before T016–T022 (code); T023 after T007; models/migrations T025–T032 after T004; adapters T033–T037 after T023, T032; T038 after adapters; T039 after T038; T040 → T041 → T042 → T043.
- US1 (Phase 3) needs T016–T017, T037, T039 only; it is the MVP and can ship first.
- US2 needs US1's cart service (T045) and T018, T020, T033–T036, T042. US3 needs US2. US4 needs T042, T021, T035, US3's cancel/release for AS-47/51. US5 needs US3 (cancel). US6 needs T033, T042 and is otherwise independent of US4. US7 needs all.
- Test task before code task in every story (T044<T045; T048<T049; T054<T055; T060–T061<T062; T067<T068; T070<T071; T074<T075).

## Parallel examples

- Phase 2 unit tests: T010–T015 together; then T016–T022 together.
- After Phase 2: US1 (T044–T047) ∥ US6 read tests (T070) ∥ US4 tests (T060–T061).
- Adapters T033–T037 all `[P]`.

## Implementation strategy

1. Phase 1 + 2 (foundation, units green, migrations applied, kit working).
2. MVP = US1 cart (stop, run `cart`).
3. Then US2 → US3 (P1 checkout path with the 200/50 race), US4 (payments), then US5, US6, US7.
4. Phase 10 only once: whole-capability run, gates, gap audit, report (task count, follow-ups met, UNVERIFIED rows).
