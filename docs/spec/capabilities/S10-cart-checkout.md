---
id: S10
title: Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S01, S03, S05, S13, S49, S50, S53]
concepts: [idempotency-key, order-reservation, payment-lifecycle, rate-limit-policy, outbox-task-queue, job-scheduler-lease, transaction-runner, problem-json-errors, access-token-session]
models: [order-status]
scope:
  - packages/backend/libs/domains/orders/**
  - packages/backend/libs/domains/seller-insights/**
  - packages/contracts/src/orders/**
---
# S10 - Cart, checkout, stock reservation and order lifecycle
## Purpose
A buyer fills a cart while signed out or signed in, signs in, and checks out. Checkout turns the cart into one order that holds the stock for 15 minutes and splits into one shop order per seller. The payment provider's signed webhook, never the browser's redirect, marks the order paid. Unpaid holds expire and return the stock. Other capabilities react to the order's events.

## Entry points
- `GET /cart` returns the caller's cart (user cart if signed in, otherwise the guest cart from the signed cookie). It never issues a cookie. [code: packages/backend/libs/domains/orders/api/cart.controller.ts#CartController]
- `PUT /cart/items/:productId` sets a line quantity. The first guest write issues the cart cookie. [code: packages/backend/libs/domains/orders/api/cart.controller.ts#CartController]
- `POST /cart/merge` moves the guest cart into the signed-in user's cart after login and clears the cookie. [code: packages/backend/libs/domains/orders/api/cart.controller.ts#CartController]
- `POST /checkout` creates the order from the cart. It answers `202` with `Location`. Needs a session and an `Idempotency-Key` header. [code: packages/backend/libs/domains/orders/api/checkout.controller.ts#CheckoutController]
- `GET /orders` lists the buyer's orders with keyset pagination. [code: packages/backend/libs/domains/orders/api/orders.controller.ts#OrdersController]
- `GET /orders/:orderId` returns one of the buyer's own orders. [code: packages/backend/libs/domains/orders/api/orders.controller.ts#OrdersController]
- `POST /orders/:orderId/cancel` lets the buyer cancel a `RESERVED` order. [code: packages/backend/libs/domains/orders/api/orders.controller.ts#OrdersController]
- `POST /webhooks/stripe` receives signed payment events. No session. It stores and queues the event, then answers `200`. [code: packages/backend/libs/domains/orders/api/stripe-webhook.controller.ts#StripeWebhookController]
- `GET /shops/:shopId/orders` lists one shop's slice of orders for members with `orders.read`, with keyset pagination and an optional `status`. [code: packages/backend/libs/domains/orders/api/shop-orders.controller.ts#ShopOrdersController]
- `POST /shops/:shopId/flash-sales` schedules a legacy flash sale. It is not part of the S10 contract and stays until S11 replaces it. It is parked in `infra/flash/` and `FlashSaleLegacyModule`. [code: packages/backend/libs/domains/orders/infra/flash/flash-sale.controller.ts#FlashSaleController]
- Topic `payments.events` (`payments.payment_succeeded`, `payments.payment_failed`, `payments.payment_refunded`) is consumed and converges with the webhook. [code: packages/backend/libs/domains/orders/infra/payments-events.consumer.ts#PaymentsEventsConsumer]
- Queue `orders-refund-requested` carries refund commands. [code: packages/backend/libs/domains/orders/infra/refund-command.adapter.ts#REFUND_REQUESTED_QUEUE]
- Events published: `order.reserved`, `order.paid`, `order.cancelled`, `order.refunded`, `order.fulfilment_changed`. [code: packages/backend/libs/domains/orders/application/events/order-events.ts#OrderPaid]
- Jobs: per-order hold expiry, expiry sweeper (every 60 s), `PENDING` recovery (every 30 s), release retry (every 30 s), cart cleanup per order, webhook processing per event, daily purge of stored webhook events (`orders.purge-webhook-inbox`), and the item title backfill (`orders.backfill-item-titles`, every 10 minutes until nothing is left). [code: packages/backend/libs/domains/orders/infra/order.jobs.ts#OrderJobs]

## Rules
- **S10.R-01** A cart belongs to one identity: a signed-in user or a guest with a signed cookie. No route takes a cart ID. [proof: S10 AS-01, S10 AS-02] [code: packages/backend/libs/domains/orders/api/cart.controller.ts#CartController]
- **S10.R-02** A signed-in caller MUST always use the user's cart. The guest cookie stays unchanged except on merge. [proof: S10 AS-02] [code: packages/backend/libs/domains/orders/api/cart.controller.ts#CartController]
- **S10.R-03** A cookie with a changed signature, no dot, a `user:` prefix, a foreign secret, an empty value or 4096 characters MUST count as "no cart". Only a freshly issued token verifies. [proof: S10 AS-04, S10 AS-11] [code: packages/backend/libs/domains/orders/domain/guest-cart-token.ts#verifyGuestToken]
- **S10.R-04** `PUT /cart/items/:productId` MUST set the quantity (0 to 20), not add it. Quantity `0` removes the line. A cart holds at most 50 lines. [proof: S10 AS-03] [code: packages/contracts/src/orders/cart.ts#CART_LIMITS]
- **S10.R-05** A cart line expires 30 days after it was last set, and an expired line MUST NOT be returned. [proof: S10 AS-09]
- **S10.R-06** Merge MUST give each product one line with quantity `min(20, user + guest)` and at most 50 lines. User lines always survive; guest-only lines follow in `addedAt`, `productId` order. `droppedLines` counts the guest lines left out. [proof: S10 AS-05, S10 AS-07, S10 AS-12] [code: packages/backend/libs/domains/orders/domain/cart-merge.ts#mergeCarts]
- **S10.R-07** Merge MUST add the guest quantities exactly once, however many merges run at the same time. [proof: S10 AS-06]
- **S10.R-08** `POST /cart/merge` MUST answer `401` without a session and leave the guest cart unchanged. [proof: S10 AS-08]
- **S10.R-09** Cart writes (`PUT`, merge) are limited to 120 per minute per identity. The 121st answers `429 rate_limited` with `Retry-After`. Reads are not limited. {{concept:rate-limit-policy}} [proof: S10 AS-10]
- **S10.R-10** `POST /checkout` MUST require a session and an `Idempotency-Key` of 8 to 128 characters. A missing key answers `422 idempotency_key_required`. {{concept:idempotency-key}} [proof: S10 AS-18, S10 AS-21] [code: packages/backend/libs/domains/orders/api/checkout.controller.ts#CheckoutController]
- **S10.R-11** Checkout MUST read prices, currency and shop from the catalog. A client `expectedTotalMinor` that differs from the server total answers `409 price_changed`. [proof: S10 AS-14]
- **S10.R-12** The same key with the same body replays the stored answer with `Idempotency-Replayed: true`. A duplicate in flight answers `409 idempotency_in_flight` with `Retry-After: 1`. The same key with another body answers `422 idempotency_key_reuse`. Keys are per buyer. [proof: S10 AS-15, S10 AS-16, S10 AS-17, S10 AS-18, S10 AS-19]
- **S10.R-13** A failure before an order exists releases the key. Once an order exists, the outcome is final for that key. [proof: S10 AS-20]
- **S10.R-14** One order MUST split into one shop order per distinct shop. Each subtotal equals the sum of its lines, and the order total equals the sum of the subtotals. [proof: S10 AS-22, S10 AS-25] [code: packages/backend/libs/domains/orders/domain/money-allocation.ts#priceCart]
- **S10.R-15** All money MUST be integer minor units. Line total = unit price × quantity − discount, and MUST be at least 0. Discounts are allocated by the largest-remainder method, ties by line position. [proof: S10 AS-23, S10 AS-25] [code: packages/backend/libs/domains/orders/domain/money-allocation.ts#allocateLargestRemainder]
- **S10.R-16** Checkout is limited to 10 requests per minute per buyer and fails closed when the limiter store is down. [proof: S10 AS-26]
- **S10.R-17** At most one checkout per buyer runs at a time. A concurrent one with another key answers `409 checkout_in_progress`. [proof: S10 AS-27]
- **S10.R-18** After checkout, a cart line is removed only if its quantity still equals the quantity the order took. A failed cleanup does not fail the checkout; a job retries it up to 5 times. [proof: S10 AS-28, S10 AS-29]
- **S10.R-19** The catalog read has a 1 s timeout and the stock call 2 s. A timeout answers `503 checkout_unavailable` with `Retry-After: 2`. [proof: S10 AS-30]
- **S10.R-20** Stock MUST change only through the catalog stock command. Operations are sorted by ascending product ID, one per product, with IDs `orders:<orderId>:reserve:<productId>`. {{concept:order-reservation}} [proof: S10 AS-31, S10 AS-35] [code: packages/backend/libs/domains/orders/domain/stock-operations.ts#buildReserveOperations]
- **S10.R-21** A reservation is all or nothing. If any line is short, no stock is held, the order is `CANCELLED(out_of_stock)`, and the buyer gets `422 out_of_stock` with `productIds`. Stock never goes below 0. [proof: S10 AS-32, S10 AS-33, S10 AS-34]
- **S10.R-22** An unpaid `RESERVED` order MUST be cancelled with reason `hold_expired` at `reservedUntil` (15 minutes after reservation), by the expiry job or by the sweeper (at most 200 orders per run). Stock returns once. [proof: S10 AS-36, S10 AS-37]
- **S10.R-23** Cancelling moves `HELD` reservations to `RELEASE_PENDING` in the same transaction. A retry job releases failures. [proof: S10 AS-38, S10 AS-40]
- **S10.R-24** An order stuck in `PENDING` for more than 60 s MUST be recovered by repeating the same stock operations. [proof: S10 AS-39]
- **S10.R-25** The webhook MUST verify the signature over the raw body in constant time, accept timestamps within ±300 s, and accept the current and, during rotation, the previous secret. [proof: S10 AS-42, S10 AS-52, S10 AS-53] [code: packages/backend/libs/domains/orders/domain/webhook-signature.ts#verifyStripeSignature]
- **S10.R-26** The webhook MUST answer `200 {received: true}` after storing and queueing the event, never after processing. A duplicate event ID answers `200 {received: true, duplicate: true}`. {{concept:outbox-task-queue}} [proof: S10 AS-41, S10 AS-43]
- **S10.R-27** Only a verified event whose payment status, amount and currency match the order marks it `PAID`. A mismatch stores the event as `REJECTED`. [proof: S10 AS-41, S10 AS-45]
- **S10.R-28** A processing failure retries with exponential backoff and jitter, up to 8 attempts. The event is never lost. [proof: S10 AS-44]
- **S10.R-29** An event without `orderId` or with an unknown one is stored as `UNMATCHED`. An unhandled type is stored as `IGNORED`. [proof: S10 AS-46]
- **S10.R-30** A late failure after `PAID` MUST be ignored. `payment_failed` cancels a `RESERVED` order. A full `charge.refunded` refunds a `PAID` or `FULFILLING` order. {{concept:payment-lifecycle}} [proof: S10 AS-47, S10 AS-48, S10 AS-49]
- **S10.R-31** The payments consumer MUST handle a repeated message once. It converges with the webhook on the same guarded transitions. [proof: S10 AS-50, S10 AS-51]
- **S10.R-32** The webhook body is capped at 64 KiB (`413`). A signed body that is not JSON or lacks `id` and `type` answers `400 invalid_payload`. [proof: S10 AS-52] [code: packages/contracts/src/orders/webhook.ts#WEBHOOK_BODY_LIMIT_BYTES]
- **S10.R-33** The order has 8 statuses and moves only by the commands `reserve`, `markPaid`, `cancel`, `startFulfilment`, `ship`, `deliver`, `refund`. Each move is a conditional change with one history row and `version` raised by 1. [proof: S10 AS-54, S10 AS-56] [code: packages/backend/libs/domains/orders/domain/order-state.ts#decide]
- **S10.R-34** Fulfilment moves only through `OrderFulfilmentService.apply`; each emits `order.fulfilment_changed`. [proof: S10 AS-57] [code: packages/backend/libs/domains/orders/application/order-fulfilment.service.ts#OrderFulfilmentService]
- **S10.R-35** The buyer's cancel answers `409 order_not_cancellable` with `currentStatus` for `PAID`, `FULFILLING`, `SHIPPED`, `DELIVERED` and `REFUNDED`, and changes nothing. A `CANCELLED` order answers `200` unchanged with no second event. An unknown or foreign order answers the same `404 order_not_found`; a malformed id answers `400`; no session answers `401`. [proof: S10 AS-55] [code: packages/backend/libs/domains/orders/application/order-cancellation.service.ts#OrderCancellationService]
- **S10.R-36** `GET /orders/:orderId` returns the buyer's own order with items, shop orders and timeline. A shop member or an admin who is not the buyer gets the same `404 order_not_found` as for a missing order. No internal field (key, request hash, user ID, version, payment reference) is returned. [proof: S10 AS-58] [code: packages/backend/libs/domains/orders/application/order-query.service.ts#OrderQueryService]
- **S10.R-37** `GET /orders` pages by keyset on `(createdAt, id)` newest first: default 20, maximum 100. It never lists another buyer's orders or `CANCELLED(out_of_stock)` ones. A limit outside 1 to 100, a malformed cursor or another buyer's cursor answers `400`. [proof: S10 AS-59] [code: packages/backend/libs/domains/orders/domain/order-cursor.ts#encodeOrderCursor]
- **S10.R-38** The history query reads only columns of the covering index and repeats its predicate, so over 10,000 orders the plan is an index-only scan without a sort. [proof: S10 AS-60] [code: packages/backend/libs/domains/orders/infra/order.repository.ts#USER_HISTORY_PAGE_SQL]
- **S10.R-39** `GET /shops/:shopId/orders` returns for every role of the shop only that shop's lines and subtotal. A member of another shop only, or a non-member, gets `404 shop_not_found`; no session gets `401`; a shop that is not `ACTIVE` follows the S03 status gate (`403` for a suspended shop). A `status` outside `PENDING`, `PAID`, `CANCELLED`, `REFUNDED` or a bad cursor answers `400`. [proof: S10 AS-61] [code: packages/backend/libs/domains/orders/api/shop-orders.controller.ts#ShopOrdersController]
- **S10.R-40** `getOrdersForShop` returns the same page as the route. `getOrderLines` takes at most 500 order IDs, reads them in one statement, leaves unknown IDs out and throws `TooManyIdsError` for 501. Neither returns a model. [proof: S10 AS-62] [code: packages/backend/libs/domains/orders/application/order-query.service.ts#OrderQueryService]
- **S10.R-41** `getPayableOrder(orderId, userId)` returns the amount, currency, hold end and per-shop allocation of the buyer's own `RESERVED` order whose hold has not ended. Otherwise it throws `OrderNotPayableError` (`order_not_reserved` or `hold_expired`); a foreign or missing order throws `OrderNotFoundError`. [proof: S10 AS-63] [code: packages/backend/libs/domains/orders/application/order-query.service.ts#OrderQueryService]
- **S10.R-42** Each applied transition appends exactly one event in the same transaction, with a strictly rising `orderVersion` that matches the envelope's aggregate version. If the append fails, the status, history, reservations and events stay unchanged and the buyer's cancel answers `503 order_unavailable` with `Retry-After`. [proof: S10 AS-64] [code: packages/backend/libs/domains/orders/application/order-lifecycle.service.ts#OrderLifecycleService]
- **S10.R-43** The realtime push after a commit is best effort. When the hub is down the transition and its events still commit, the failure is counted in `orders_realtime_failed_total`, and `GET /orders/:orderId` shows the new status. [proof: S10 AS-65] [code: packages/backend/libs/domains/orders/infra/realtime.adapter.ts#RealtimeAdapter]
- **S10.R-44** Logs MUST carry the order ID for checkout and webhook results and MUST NOT contain the webhook body, the signature, a secret, a cookie, an authorization header or an idempotency key. The metrics `orders_checkout_total`, `orders_reservation_expired_total`, `orders_webhook_events_total`, `orders_discount_fallback_total` and `orders_paid_after_cancel_total` have bounded labels. [proof: S10 AS-66]
- **S10.R-45** Every job is safe to run twice or on two instances at once with one effect. The purge removes stored `stripe` webhook events older than 35 days (35 days plus 1 s is removed, exactly 35 days is kept) and no other source. The backfill gives items without a title the product's title, or `(removed product)` when the product is gone, and sets `lineTotalMinor` to unit price × quantity in batches of 200. [proof: S10 AS-67] [code: packages/backend/libs/domains/orders/infra/order.jobs.ts#OrderJobs]
- **S10.R-46** The domain exports no model outside its marked TRANSITIONAL block, holds no association or import into another domain, has no direct `sequelize.transaction`, and leaves one table-ownership finding (the S12 export join on `Product`). [proof: S10 AS-68]
- **S10.R-47** `POST /checkout` accepts an optional `refCode` of 3 to 64 characters of `[A-Za-z0-9_-]`. A valid code is stored on the order; an absent code leaves it empty, and a malformed one answers `400 validation_failed` with no order. The code is part of the request fingerprint, so the same key with another code answers `422 idempotency_key_reuse`. [proof: S10 AS-69]

## Behaviors
- **S10.B-01** Given a guest with no cookie, when `GET /cart`, then `200 {lines: [], droppedLines: 0}` and no `Set-Cookie`; the first `PUT` issues the cookie. [proof: S10 AS-01]
- **S10.B-02** Given a user with a guest cookie, when the user sets a line, then it lands in the user's cart and the guest cart and cookie are untouched. [proof: S10 AS-02]
- **S10.B-03** Given a user cart `{A: 1, B: 19}` and a guest cart `{A: 3, B: 5, C: 2}`, when merged, then the cart is `{A: 4, B: 20, C: 2}` and the cookie is cleared. [proof: S10 AS-05]
- **S10.B-04** Given a user cart with 40 lines and a guest cart with 20 other products, when merged, then the cart holds 50 lines and `droppedLines` is 10. [proof: S10 AS-07]
- **S10.B-05** Given a cart with A × 2 (shop S1, 1000) and B × 1 (shop S2, 500), when the buyer checks out, then `202` returns an order in `RESERVED` with two shop orders and a 15-minute hold. [proof: S10 AS-13, S10 AS-22]
- **S10.B-06** Given A costs 1200 now and the client sent `expectedTotalMinor` 2000 for A × 2, when checking out, then `409 price_changed` returns the current total. [proof: S10 AS-14]
- **S10.B-07** Given a completed checkout, when the same key and body are sent again, then the stored `202` returns with `Idempotency-Replayed: true`, even after the order is `PAID`. [proof: S10 AS-15]
- **S10.B-08** Given five identical concurrent requests, when they run, then one order exists and stock is deducted once. [proof: S10 AS-17]
- **S10.B-09** Given an empty cart, an unknown, archived or sandbox product, or a shop that is not `ACTIVE`, when checking out, then `422` (`cart_empty` or `product_unavailable`). [proof: S10 AS-21]
- **S10.B-10** Given a seller discount of 300 on a shop grossing 2000, when checking out, then the shop subtotal is 1700 and the order total drops by 300. [proof: S10 AS-24]
- **S10.B-11** Given stock A: 50 and 200 buyers, when all check out at once, then 50 get `202`, 150 get `422 out_of_stock`, and stock is 0. [proof: S10 AS-32]
- **S10.B-12** Given carts that hold A and B in opposite order, when 200 checkouts run at once, then all answer `202` and none answers `5xx`. [proof: S10 AS-34]
- **S10.B-13** Given a `RESERVED` order at `reservedUntil − 1 s`, when the expiry job runs, then nothing changes; at `reservedUntil` it becomes `CANCELLED(hold_expired)` and stock returns. [proof: S10 AS-36]
- **S10.B-14** Given the stock release fails once, when the cancel commits, then the order is `CANCELLED`, reservations are `RELEASE_PENDING`, and a retry later releases them. [proof: S10 AS-38]
- **S10.B-15** Given a `RESERVED` order, when its buyer cancels, then `200` with `CANCELLED(user_cancelled)`, stock restored once, one `order.cancelled` event; another user gets `404 order_not_found`. [proof: S10 AS-40]
- **S10.B-16** Given a signed `payment_intent.succeeded` with matching amount and currency, when posted, then `200 {received: true}` returns and the order becomes `PAID`. [proof: S10 AS-41]
- **S10.B-17** Given the same event delivered ten times at once, when posted, then one event, one job and one transition result. [proof: S10 AS-43]
- **S10.B-18** Given the payments status check is down, when the job runs, then the event stays `RECEIVED` and retries; after recovery the order becomes `PAID`. [proof: S10 AS-44]
- **S10.B-19** Given a buyer cancel and the success event race 50 times, when both run, then each run ends `PAID` (cancel answers `409 order_not_cancellable`) or `CANCELLED` (with one refund command). [proof: S10 AS-51]
- **S10.B-20** Given a `PAID` order, when `startFulfilment`, `ship {trackingCode}` and `deliver` run in order, then the order moves to `FULFILLING`, `SHIPPED`, `DELIVERED`. [proof: S10 AS-56, S10 AS-57]

## Lifecycles
Statuses: `PENDING`, `RESERVED`, `PAID`, `FULFILLING`, `SHIPPED`, `DELIVERED`, `CANCELLED`, `REFUNDED`. Checkout writes `PENDING` and then moves to `RESERVED`. The webhook or the payments consumer moves to `PAID` or cancels. The expiry job, the sweeper and the buyer cancel. The fulfilment service moves `PAID` onwards. A refund moves `PAID` or `FULFILLING` to `REFUNDED`. Shop orders follow the order (`PENDING`, `PAID`, `CANCELLED`, `REFUNDED`). Reservations pass `REQUESTED`, `HELD`, `CONVERTED`, `RELEASE_PENDING`, `RELEASED`. See [order-status](../models/order-status.md).

## Owns
- Tables: `BisOrder`, `BisOrderItem`, `ShopOrder`, `StockReservation`, and the webhook inbox rows through the S53 inbox service.
- Queue: `orders-refund-requested`.
- Events: `order.reserved`, `order.paid`, `order.cancelled`, `order.refunded`, `order.fulfilment_changed`.
- Rate-limit policies: `orders.cart-write.identity` (120 per minute), `checkout.create` (10 per minute), `orders.webhook.ip` (300 per minute).
- Configuration: cart cookie secret, current and previous webhook secrets, hold length, timeouts, limits and retry counts (validated at startup). [code: packages/backend/libs/common/config/orders-config.ts#OrdersConfig]
- The cart lives only in the cart store (DynamoDB). It never touches the relational database.

## Decisions
- The cart never touches the relational database, so add-to-cart bursts do not load Postgres.
- Prices are read on the server, because client prices are never trusted.
- The order is written and committed first, then stock is reserved, then the order moves to `RESERVED`; no transaction spans the stock call. Recovery repeats the same operation IDs.
- Only the signed webhook marks an order paid; the route acknowledges first and applies later, so a slow check never causes a provider retry.
- Stock operations are sorted by product ID to avoid deadlocks.
- Seller discounts fail safe: a timeout of 250 ms, an error or an invalid answer falls back (no discount).
- Reservations have a source (`CATALOG` here) so S11 can add flash-sale stock without changing the order flow.
- Each transition is a guarded conditional update, so racing triggers apply a move once.

## Known gaps
- The discount fallback (250 ms timeout) appears in the specification; the facts show no test with a fallback scenario, so it is not a rule.
- The rate-limit store failing open for cart writes and the webhook has no test in the list.
- AS-24 is proven for the discount path only. The fail-safe branch is not tied to a test.
- The statement that the transition table allows exactly the listed moves (AS-54) is tested only at unit level.
- The legacy flash-sale route has no scenario; its start and reconcile jobs are tested only for stock moving through the catalog (`flash-sale-legacy.e2e-spec.ts`).
- The `requestId` and `traceId` on every log line come from the platform logger and are not re-proven in the orders specs (R-44 covers the order ID and the absence of secrets).
- The platform's own inbox purge (`inbox.purge`, 30 days, all sources) still removes `stripe` events at 30 days, five days before the 35 days of R-45. S53 must exclude that source from it.
- `OrderService` (auctions compat) still moves orders by its own guarded SQL; it is deleted when S21 creates auction orders through an order-creating command.