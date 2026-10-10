# Gaps: S10 — current `orders` code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/libs/domains/orders/` unless stated; line numbers are those read on 2026-10-05 (a leading `≈` means the line was located by reading, not by search). Section C was produced with `pnpm --dir packages/backend check:table-ownership` (run on 2026-10-05: 87 findings in 21 domains; `orders` has 12).

Order of work suggested at the end (section F). Questions behind each row are in [`questions.md`](questions.md); scenario IDs refer to [`spec.md`](spec.md).

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Checkout answers the framework default `201`, body has `total` and `paymentIdempotencyKey`; no `Location` | `api/orders.controller.ts:38-43`, `application/checkout.service.ts:216-223` | FR-016, AS-13 |
| A2 | Idempotency is a hand-written `findOne({userId, idempotencyKey})` plus a unique-violation fallback; concurrent duplicates all get the order (no `409`), different body is not detected (no fingerprint), key regex gives `400` | `application/checkout.service.ts:81,129-132`, `api/orders.controller.ts:22,40` | FR-011–FR-013, AS-15–AS-20 |
| A3 | No `expectedTotalMinor`, no `409 price_changed`; no body DTO, unknown properties not rejected | `api/orders.controller.ts:38-43` | FR-011, FR-014, AS-14 |
| A4 | Prices and shops are read from the catalog table with `productModel.findAll` (`price` as `Number(product.price)`); no `status`, `isSandbox` or shop-status check; a missing product is reported as `OUT_OF_STOCK` | `application/checkout.service.ts:87-92,99,123` | FR-014, FR-015, AS-21 |
| A5 | Stock is decremented by raw SQL inside the order transaction (cross-domain write, one transaction over two owners) | `application/checkout.service.ts:149-152` | FR-025, FR-026, AS-31 |
| A6 | Release on cancel is raw SQL on `Product` inside the cancel transaction; flash units released after commit with errors swallowed; no `RELEASE_PENDING`, no retry job | `application/order.service.ts:89-115` | FR-030, AS-36, AS-38 |
| A7 | No `PENDING` recovery: the order is created `PENDING`, moved to `RESERVED` in the same transaction, so there is no crash window to recover; once the saga is split (A5) the recovery job and its tests are new | `application/checkout.service.ts:139-205` | FR-025, FR-031, AS-39 |
| A8 | Expiry only through one delayed job per order; no sweeper backstop; no age/lease for orders; the job swallows `ConflictException` silently | `infra/order.jobs.ts:31-38`, `application/checkout.service.ts:197-198` | FR-029, AS-36, AS-37 |
| A9 | Discounts: port returns per-line unit prices, applied with `Math.min`; no allocation, no validation of results, no timeout, no fallback metric | `domain/checkout-discounts.port.ts:13-15`, `application/checkout.service.ts:114-119` | FR-018, AS-23, AS-24 |
| A10 | Money: total is `reduce(price × quantity)` over `Number()` values; shop subtotals keyed by nullable `shopId` (a product without a shop becomes a `null` shop order); currency falls back to `'EUR'`; no mixed-currency check | `application/checkout.service.ts:140,166-170,192,220` | FR-015, FR-017, FR-019, AS-22, AS-25 |
| A11 | Clock read directly (`Date.now()`, `new Date()`) for the hold deadline | `application/checkout.service.ts:139` | FR-058 |
| A12 | No per-buyer checkout lock; two tabs with different keys can both consume one cart | `application/checkout.service.ts:80-125` | FR-022, AS-27 |
| A13 | Cart cleanup deletes every line read (`clear`), silently on error (`warn`); lines changed or added during checkout are lost; no cleanup job | `application/checkout.service.ts:125`, `infra/cart.repository.ts:71-82` | FR-023, AS-28, AS-29 |
| A14 | No time budget or timeouts around catalog, stock, discount calls; no `503 checkout_unavailable` | `application/checkout.service.ts` (absent) | FR-024, AS-30 |
| A15 | State machine: `cancel` allowed from `PENDING` and `RESERVED` for every reason; no per-reason restriction; no actor in history; "already in the target state" is returned as `null` and shown to the buyer as `{cancelled: false}`; illegal moves are an unstructured `409` message | `domain/order-state.ts:27-31,45-47`, `application/order.service.ts:35-52`, `api/orders.controller.ts:57-62` | FR-043–FR-045, AS-54–AS-56 |
| A16 | No `refund` flow from events; `REFUNDED` payment status is mapped to `cancel` (illegal from `PAID`, only logged) | `infra/order-payment.listener.ts:45-50` | FR-039, AS-49 |
| A17 | A payment that completes after cancellation or expiry is logged and dropped; no refund command | `infra/order-payment.listener.ts:48-50`, `api/stripe-webhook.controller.ts:64-67` | FR-038, AS-47 |
| A18 | `markPaid` does not compare amount or currency with the order and does not re-check the payment | `application/order.service.ts:61-82` | FR-035, AS-45 |
| A19 | Webhook processes inline and swallows failures (`.catch(warn)`); the inbox row is inserted first, so a failed `markPaid` is lost forever (retry sees `duplicate`); no job, no retries, no dead letter, no result states | `api/stripe-webhook.controller.ts:48-70` | FR-034–FR-037, AS-41, AS-44 |
| A20 | Webhook finds the payment through `PaymentModel` by `idempotencyKey` metadata, not by order ID; unmatched events are only logged | `api/stripe-webhook.controller.ts:32,55-60` | FR-035, AS-46 |
| A21 | Webhook secret checked per request (`400 Unsigned webhook` if missing); no rotation; no body cap; `@SkipThrottle()`; error bodies are plain `BadRequestException` text, not `invalid_signature` / `invalid_payload` | `api/stripe-webhook.controller.ts:23,38-46` | FR-033, FR-042, AS-42, AS-52 |
| A22 | Inbox access is raw SQL on `ProcessedWebhookEvent` (owner `infrastructure:idempotency`) from the controller | `api/stripe-webhook.controller.ts:48-53` | FR-057 (IX.6), AS-68 |
| A23 | Payment-result consumer reads an untyped payload from `payments.responses`, skips malformed messages with `continue` (no DLQ), skips legacy orders by looking at the model | `infra/order-payment.listener.ts:11-13,35-43` | FR-040, AS-50 |
| A24 | Reads return ORM models: `get` returns `order.get({plain: true})` plus raw timeline SQL; `history` is raw SQL with a `before` timestamp, no tiebreaker, no cursor, no limit validation | `application/order.service.ts:118-126`, `application/checkout.service.ts:225-235`, `api/orders.controller.ts:45-55` | FR-048, FR-049, FR-052, AS-58, AS-59 |
| A25 | `get` and `cancel` do the ownership check by calling `get` first (extra read), `cancel` then runs unscoped | `api/orders.controller.ts:57-62`, `application/order.service.ts:118-120` | FR-045, FR-048, AS-40, AS-58 |
| A26 | No seller list route; no `OrderQueryService` (`getOrdersForShop`, `getOrderLines`, `getPayableOrder`) and no `OrderFulfilmentService`; the barrel exports models instead | `index.ts:8-13` | FR-047, FR-050, FR-051, AS-57, AS-61–AS-63 |
| A27 | Event payloads: `total`, `price`, no `shopOrders`, no `title`, no `orderVersion`; `OrderCancelled` has no previous status; no `order.refunded`, `order.fulfilment_changed`, `orders.refund_requested`; schemas not in `packages/contracts` | `application/events/order-events.ts:5-30` | FR-053, AS-64 |
| A28 | Realtime push after commit is correct but its failure is swallowed without a metric | `application/order.service.ts:128-131` | FR-054, AS-65 |
| A29 | Cart: secret falls back to `jwt_secret`; `GET` issues a cookie; merge returns `201`; `lastIndexOf('.')` of `-1` is not handled explicitly | `api/cart.controller.ts:27,31-35,50-58,63`, `api/cart-identity.ts:18-24` | FR-004, FR-005, FR-007, AS-04, AS-11 |
| A30 | Cart store: `list` does not filter expired lines; `setLine` overwrites `addedAt` and clamps silently; no 50-line cap; `merge` is read-then-write (two concurrent merges double-count; 25-item batches can half-apply), summed quantity capped but lines not; `clear` unconditional | `infra/cart.repository.ts:20-82` | FR-003, FR-006–FR-008, AS-03, AS-06, AS-07, AS-09 |
| A31 | No rate limits on cart writes, cancel or webhook; only `checkout.create` exists | `api/cart.controller.ts`, `api/orders.controller.ts:57-58`, `infrastructure/rate-limit/rate-limit.types.ts:41` | FR-009, FR-021, FR-042, AS-10, AS-26 |
| A32 | API layer imports `infra` (`MAX_LINE_QUANTITY` from `cart.repository` into the DTO; models into controllers); controllers hold logic (regex check, flash-sale creation with queries and job scheduling) | `api/orders.dto.ts:3`, `api/orders.controller.ts:22,31-32,40,64-76`, `api/cart.controller.ts:8`, `api/stripe-webhook.controller.ts:5-12` | II.1, I.2 (debt D-6) |
| A33 | Application services import `infra` classes and models directly | `application/checkout.service.ts:4-8,14-15`, `application/order.service.ts:3-4,9` | I.2 (debt D-6) |
| A34 | Controllers use `Firewall`, `@User()` and `UserRawDto` of the old identity API | `api/cart.controller.ts:5`, `api/orders.controller.ts:5` | S01 contract (`AuthenticatedUser`) |
| A35 | No DTOs or zod schemas in `packages/contracts` for cart, checkout, orders, events; `bis-order.dto.ts` is a legacy shell (`CreateBisOrderDto`) exported from the barrel | `api/bis-order.dto.ts`, `index.ts:17` | FR-052, V.2 |
| A36 | Hold, limits, timeouts and retry counts are constants in code (`RESERVATION_HOLD_MS`, `MAX_LINE_QUANTITY`, `TTL_SEC`) not validated configuration | `application/checkout.service.ts:22`, `infra/cart.repository.ts:14-16` | FR-058 |
| A37 | Data model: `BisOrderItem` has no `title`, `discountMinor`, `lineTotalMinor`; `ShopOrder.shopId` nullable; `StockReservation.status` lacks `REQUESTED` and `RELEASE_PENDING`; `OrderEvent` has no actor; `BisOrder` has no request fingerprint and no `CHECK` on `status`; history index lacks `id` tiebreaker and `currency`; `userId` is `TEXT` | `infra/models/*.ts`, `migrations/20261001150000-checkout-orders-inventory.js:15-100` | FR-020, FR-030, FR-043, FR-049 |
| A38 | Flash-sale code lives in this domain's checkout, controller, jobs, module and barrel (`FlashStockService`, `FlashSale` model, `POST /shops/:shopId/flash-sales`, `flash-sale.*` jobs); S10 moves it behind `ReservationSource` and S11 takes it over | `application/checkout.service.ts:93-110,208-212`, `application/order.service.ts:108-113`, `api/orders.controller.ts:64-76`, `infra/order.jobs.ts:41-113`, `index.ts:10,20` | FR-032, S11 |
| A39 | `OrdersWorkerModule` hosts an `OrderStateModule` that duplicates the provider list to give the projector what it needs | `orders-worker.module.ts:11-19` | X.4, D-8 |
| A40 | Existing tests: `checkout.e2e-spec.ts` calls services directly for six of seven cases (`:62-170`), injects `Product`, `Payment`, `User` models and uses `issueTokensFor`; no `401`, validation, IDOR, rate-limit, cancel, history, replay-after-paid, webhook-signature matrix; `cart.e2e-spec.ts` has 3 happy tests only | `checkout.e2e-spec.ts`, `cart.e2e-spec.ts` | VII.2, VII.3, VII.4, VII.6, test-plan |
| A41 | No unit specs for the state machine, money allocation, merge rule, token, signature, stock operation builder (only `flash-stock.service.spec.ts`, which belongs to S11) | `domain/` | AS-11, AS-12, AS-23, AS-25, AS-35, AS-53, AS-54 |
| A42 | Observability: no metrics for checkout outcomes, expiry, release backlog, webhook results, cart cleanup, discount fallback; logs interpolate ids but nothing proves absence of bodies and secrets | whole domain | FR-055, AS-66 |
| A43 | Legacy orders created before the state machine (no `idempotencyKey`) are skipped by the listener `if (!order?.idempotencyKey) continue` and have no items with titles | `infra/order-payment.listener.ts:41-43` | AS-50 (all orders follow the machine), migration note below |

## B. Debt register rows that name `orders` or S10

| ID | What (from `docs/architecture/debt-register.md`) | What S10 does | Mechanism |
|---|---|---|---|
| D-6 (I.2) | `api/` and `application/` import `infra/` directly | Repository ports in `domain/` (order, cart, reservation, inbox, history), adapters in `infra/`; DTOs no longer import `infra`; controllers call one service | I.2 layering (A32, A33) |
| D-7 (IX.4) | Other domains import `BisOrderModel` etc.; orders imports `ProductModel`, `UserModel`, `PaymentModel` | Orders stops importing foreign models (section C rows 1–12). The `BisOrderModel`, `BisOrderItemModel`, `ShopOrderModel`, `StockReservationModel`, `FlashSaleModel` exports are **removed from the barrel last**, after S13, S16, S21, S31, S42, S43 have migrated to the exports below | R1 exports (`OrderQueryService`, `OrderFulfilmentService`) and R3 events |
| D-8 (X.4) | Barrels export infrastructure internals | `FlashStockService` (`index.ts:20`), `OrderService`, `OrderExportService`, `OrdersWorkerModule` internals: S10 removes `OrderService` and `FlashStockService` from the barrel (services replaced by `OrderQueryService`, `OrderFulfilmentService`); `OrderExportService` goes with S12 | X.4 |
| D-10 (D2) | Order export routes and worker branch live in `catalog-sync`; orders duplicates the queue name | Not paid here (S12); S10 keeps `order-export.service.ts` untouched except for its `Product` join, which S12 replaces with the item title snapshot | S12 |
| D-11 (X.5) | `orders ↔ payments` reference each other's models; lazy accessor hides a `CircularDependencyException` | S10 drops `PaymentModel` from `bis-order.model.ts` (`HasMany`), `orders.module.ts` and the webhook controller; payments reads orders only through `getPayableOrder`; the lazy accessors in `bis-order.model.ts:25-26` and S13's `payment.model.ts` / `bis-order.model.ts` are deleted once both sides are done | R1 (`getPayableOrder`, `getPaymentStatus`) + events |
| D-12 (IX.4) | Raw SQL on tables owned by other domains | Section C below | R1 / R3 |
| D-15 (X.5) | The static domain graph's strongly connected component {catalog, discovery, experimentation, orders, payments} | S10 removes orders → catalog model access, orders → payments model access and orders → identity model access; remaining edges are R1 calls (one direction: orders → catalog, orders → tenancy, orders → payments query) which stay acyclic once payments → orders is only `getPayableOrder` and catalog does not call orders | IV.2 |
| D-17 (X.5) | File-level cycle `bis-order ↔ bis-order-item` models (mutual associations, lazy arrows) | Repositories return plain records; the Sequelize models keep one-way associations (item → order) or none; the lazy `require` in `bis-order.model.ts:25-26` is deleted | I.2 |

## C. `pnpm --dir packages/backend check:table-ownership` lines for `orders` (12) and what replaces each

| Finding | File | Replacement |
|---|---|---|
| SQL `Product` | `application/checkout.service.ts` (`:149` raw stock update; `:87` model query) | R1 `ProductQueryService.getProductsByIds` for price, currency, status, shop; R1 `ProductStockService.applyStockDelta` for reserve |
| SQL `Product` | `application/order-export.service.ts` (`LEFT JOIN "Product"` at `:69`) | S12: read titles from the order item snapshot (no catalog read); fallback R1 `getProductsByIds` per page for legacy items |
| SQL `Product` | `application/order.service.ts:97` | R1 `applyStockDelta` with release operation IDs, through the `RELEASE_PENDING` job |
| SQL `Product` | `infra/order.jobs.ts:50,106` (flash start and reconcile) | S11: R1 `applyStockDelta` with operation IDs `orders:flash:<saleId>:load` and `…:return` |
| MODEL `ProductModel` | `api/orders.controller.ts:11,32` | Flash-sale route leaves with S11; product existence check there is R1 `getProductsByIds(ids, {shopId})` |
| MODEL `ProductModel` | `application/checkout.service.ts:8` | R1 `getProductsByIds` |
| MODEL `ProductModel` | `infra/models/bis-order-item.model.ts:14,36-39` | Drop association and import; item keeps `title` and `shopId` snapshots; `productId` is a plain ID with no foreign key |
| MODEL `ProductModel` | `orders.module.ts:8,24` | Remove from `ORDER_MODELS` |
| MODEL `UserModel` | `infra/models/bis-order.model.ts:18,≈62` | Remove `@BelongsTo(User)`; `userId` is a plain ID (UUID, no FK) |
| MODEL `PaymentModel` | `api/stripe-webhook.controller.ts:11,32` | Order from intent metadata `orderId`; payment confirmed by R1 `PaymentQueryService.getPaymentStatus` (S13) |
| MODEL `PaymentModel` | `infra/models/bis-order.model.ts:25-26,≈64` | Remove `@HasMany(Payment)` and the lazy accessor |
| MODEL `PaymentModel` | `orders.module.ts:9,24` | Remove from `ORDER_MODELS` |

Other domains' findings on the tables `orders` owns (they are those capabilities' to-do, listed so S10 ships what they need):

| Consumer finding | Replacement (and which capability does it) |
|---|---|
| asset-library `application/assets.service.ts` (SQL `BisOrder`, `BisOrderItem`) | R1 `getOrderLines` (S31) |
| auctions `infra/auction.jobs.ts` (SQL `BisOrderItem`, `ShopOrder`, `BisOrderModel`) | S21: winner's checkout through an order-creating command that S21 specifies (see questions `[CONTRACT]` S21), lines through `getOrderLines` |
| developer-platform `application/public-orders.service.ts` (SQL `BisOrder`, `BisOrderItem`, `ShopOrder`) | R1 `getOrdersForShop`, `getOrderLines` (S42) |
| developer-platform `infra/webhook-router.projector.ts` (SQL `ShopOrder`) | Consume `order.paid`, `order.cancelled`, `order.refunded` events (S43, R3) |
| statements `application/statement.service.ts`, `infra/statement-export.ts` (SQL `BisOrder`, `BisOrderItem`) | R3: ClickHouse fed by CDC/outbox (S16) |
| payments `infra/models/payment.model.ts`, `ledger.module.ts` (`BisOrderModel`) | R1 `getPayableOrder` and events; drop the association (S13) |

## D. Contract and infrastructure work this spec depends on

| # | Needed | Owner | Used by |
|---|---|---|---|
| D1 | `PaymentQueryService.getPaymentStatus`, `payments.events` topic and event types, intent metadata `orderId`, consumer of `orders.refund_requested` | S13 | FR-035, FR-038, FR-040 |
| D2 | `evaluateDiscounts` returning `shopDiscounts` | S45 | FR-018 |
| D3 | Inbox service with status and attempts, purge | S53 | FR-034, FR-037, FR-056 |
| D4 | Idempotency facility with "release on failure before an order exists" | S54 | FR-012, FR-013 |
| D5 | Rate-limit policies `orders.cart-write.identity`, `orders.cancel.user`, `orders.webhook.ip` | S50 | FR-009, FR-042 |
| D6 | `ShopQueryService.getShopsByIds` with `status`, `isSandbox` | S03 | FR-015 |
| D7 | Config schema: cart cookie secret, webhook secrets (current, previous), hold, limits, timeouts | S54 | FR-004, FR-033, FR-058 |
| D8 | `packages/contracts` schemas: `cartSchema`, `checkoutRequestSchema`, `checkoutResponseSchema`, `orderSchema`, `orderListItemSchema`, `orderPageSchema`, `shopOrderPageSchema`, `orderEventSchemas`, `webhookAckSchema` | S10 | V.2, VII.6 |
| D9 | Ownership registry entries for any new table or column set (reservation statuses, request fingerprint) | S10 | IX.3 |

## E. Data migration notes (expand/contract, III.11)

- Expand: add `title`, `discountMinor`, `lineTotalMinor` to items; `requestHash` to orders; `actor` to history; `REQUESTED` and `RELEASE_PENDING` reservation statuses; a `CHECK` on `status` values; a unique `(bisOrderId, productId)` on reservations; `NOT NULL` `shopId` on `ShopOrder` only after the backfill below; the history index `(userId, createdAt DESC, id DESC) INCLUDE (status, total, currency)`. Every migration sets `lock_timeout`; index creation is concurrent.
- Backfill: items of orders created before this change get `title` from R1 `getProductsByIds` in batches (job `orders.backfill-item-titles`, resumable, retired after it finishes) and `lineTotalMinor = priceAtPurchase × quantity`; products that no longer exist get the title `"(removed product)"`; rows with `shopId IS NULL` are reported, not guessed.
- Contract (later release): drop foreign keys from `BisOrderItem.productId` to `Product` and `BisOrder` to `User` if present; remove the `ProcessedWebhookEvent` raw access; rename columns in the API only (database column names may stay).

## F. Suggested order of work

1. Contracts and config: schemas (D8), config (D7), clock, ownership entries (D9).
2. Domain layer: state machine with reasons (AS-54), money allocation (AS-23, AS-25), stock operation builder (AS-35), cart merge and token (AS-11, AS-12), webhook signature (AS-53) — all pure, with their unit specs.
3. Cart: store with expiry, atomic merge, caps, controller, rate limit (AS-01–AS-10).
4. Order aggregate and repositories behind ports; saga split (A5–A7), reservation source seam, recovery, release and expiry jobs (AS-31–AS-40).
5. Checkout use case on the idempotency facility (AS-13–AS-30).
6. Webhook: inbox, job, status check, result states; payments consumer (AS-41–AS-53).
7. Reads and exports (AS-57–AS-63); events and observability (AS-64–AS-67).
8. Remove foreign models and associations (section C); leave the model exports in the barrel until the consumers in section C have migrated, then remove them and run `check:table-ownership --strict` (AS-68).
9. Rewrite the e2e specs to the files in `test-plan.md`; delete direct service calls and model injections; record the green run (VII.9).

## Sibling-spec follow-ups

Written by `/speckit-plan` on 2026-10-10. Other capabilities' specs are not edited; each bullet is what that capability must adopt because S10 changes a name, shape or contract they rely on. Importer files named below exist in the repository today and are the ones WP-13 adapts minimally (field reads only) so the monorepo keeps compiling; their owners confirm or redo the change.

- **S13**: bind `PaymentStatusPort` by exporting `PaymentQueryService.getPaymentStatus(paymentRef)` (shape in `spec.md`); until then every Stripe success ends `FAILED` after 8 attempts. Publish `payments.events` (`payments.payment_succeeded | payment_failed | payment_refunded` v1) with the payload S10 validates (`packages/contracts/src/orders/payment-events.ts`; take ownership of that file if preferred). Put `orderId` in intent metadata; create an intent only from `OrderQueryService.getPayableOrder`, idempotency key = `orderId`; stop reading `paymentIdempotencyKey` (removed from the `POST /checkout` answer). Consume `orders.refund_requested` v1. Drop the `BisOrderModel` association and import in `payments/infra/models/payment.model.ts` and `ledger.module.ts`, and the lazy accessors on both sides (D-11); `payment.e2e-spec.ts` stops importing `BisOrderModel`.
- **S11**: take over `infra/flash/` (`flash-stock.service.ts` and its spec, `flash-sale.model.ts`, flash jobs, `POST /shops/:shopId/flash-sales`) and `FlashSaleLegacyModule`; implement flash sources behind `ReservationSource` (`reserve`, `release`, `convert`; reservation `source`/`sourceRef`); restore the drop behaviour at checkout through the seam; delete the TRANSITIONAL exports `FlashStockService` and `FlashSaleModel`. S10 only replaced the raw `Product` SQL in the parked flash jobs by `applyStockDelta` (`orders:flash:<saleId>:load|return`).
- **S12**: `order-export.service.ts` is untouched; replace its `LEFT JOIN "Product"` (line 69) with the item `title` snapshot (legacy items: `getProductsByIds` per page). `check:table-ownership --strict` for `orders` reaches 0 only then. Then `OrderExportService` and `ExportJobTopicsModule` leave the transitional block.
- **S45**: provide `evaluateDiscounts(cart) → { shopDiscounts: [{shopId, discountMinor}] }`. S10 now allocates to lines; until S45 adopts it, S10 converts the old per-line `CheckoutDiscounts` result into shop amounts (`LegacyCheckoutDiscountsAdapter`). `shop-functions` imports `CheckoutDiscounts` and `DiscountableLine`, which stay in the transitional block until it moves.
- **S21**: auction winner checkout needs an order-creating command that S21 must specify; today `auctions/infra/auction.jobs.ts` creates orders with `BisOrderModel` and calls `OrderService.transition`, and `auctions-worker.module.ts` instantiates `OrderService` and `FlashStockService` itself (kept compatible, same constructor). Move to `OrderFulfilmentService`/the new command and `getOrderLines`; then both classes and `BisOrderModel` leave the barrel.
- **S19, S20**: call `OrderFulfilmentService.apply(orderId, {type: 'startFulfilment' | 'ship' | 'deliver'})`; read `order.paid` with `lines`/`shopOrders`; catch `InvalidOrderTransitionError`.
- **S28, S34, S36, S40, S43, J01 and the in-repo importers** (event rename: `total`→`totalMinor`, line `price`→`unitPriceMinor` and new `title`, `discountMinor`, `lineTotalMinor`, `paymentId`→`paymentRef`, `shopOrders`, `orderVersion`, `previousStatus` on `order.cancelled`; new events `order.refunded`, `order.fulfilment_changed`): `notifications/infra/notification-router.projector.ts`, `experimentation/infra/purchase-events.projector.ts`, `developer-platform/infra/webhook-router.projector.ts`, `discovery/infra/order-baskets.projector.ts`, `seller-insights/infra/{leaderboard,shop-sales,shop-live}.projector.ts`, `payments/infra/settlement.listener.ts` (S14), and their e2e specs that build `OrderPaid`/`OrderReserved`/`OrderCancelled` payloads (`notifications.e2e-spec.ts`, `webhooks.e2e-spec.ts`, `leaderboards.e2e-spec.ts`, `finance.e2e-spec.ts`). S43 also consumes `order.refunded`.
- **S31**: replace the SQL on `BisOrder`/`BisOrderItem` in `asset-library/application/assets.service.ts` with `getOrderLines`; stop importing `BisOrderModel` in `assets.e2e-spec.ts`.
- **S42**: `developer-platform/application/public-orders.service.ts` moves to `getOrdersForShop`/`getOrderLines` (money fields now `…Minor`).
- **S16, S14**: statements stop reading order tables (R3 via CDC/outbox); settle on `order.paid` shop split.
- **S48, W03**: `POST /checkout` answers `202` + `Location` with `{orderId, status, totalMinor, currency, reservedUntil}` (no `paymentIdempotencyKey`); `Idempotency-Key` is mandatory (`422` codes); `POST /cart/merge` answers `200`; `GET /cart` sets no cookie; carts hold ids, quantities and `addedAt` only (compose titles/prices through the batch product endpoint); orders and history use `…Minor` fields, keyset `{items, nextCursor}`, `404 order_not_found` for foreign orders; problem codes in `plan.md`/`contracts/http.md`.
- **S54**: an empty body and `{}` produce **different** idempotency fingerprints (`fingerprint.ts` hashes `undefined` as nothing and `{}` as `{}`); S10 normalises its own route with a middleware (`api/empty-body.middleware.ts`), but S54 may prefer to treat an absent JSON body as `{}` for every route, which would make that middleware redundant; confirm `AppError.idempotencyFinal` is the supported way to store a post-order `422 out_of_stock`.
- **S53**: no change asked (`InboxService.claim/markStatus/purge` already match); S10 relies on `purge(olderThan)` deleting only webhook rows, not consumer `recordOnce` rows younger than the cut.
- **S50**: register `orders.cart-write.identity`, `orders.cancel.user`, `orders.webhook.ip` (S10 declares them in `ordersRatePolicies`; no registry change expected beyond the policy table).
- **S13 (added by the first implementation pass)**: orders no longer consumes the transitional `payment.processed` message (the retired `OrderPaymentListener`); it consumes only `payments.payment_succeeded|failed|refunded` v1. Until S13 publishes those (and binds `PaymentStatusPort`), no payment completes an order: the live webhook path ends `FAILED` after 8 attempts (fail closed, plan R-3/R-4). The consumer also refuses (permanent failure) a `payment_succeeded` whose `amountMinor` or `currency` differs from the order. `OrderPaid.paymentRef` replaces the old `paymentId`; `payments/infra/settlement.listener.ts` now stores `paymentRef` in the ledger's `paymentId` column (S14/S13 decide whether that column should hold the provider reference or the payment id).
- **S05**: no change asked. Note for their test plan: two checkouts holding the same products in opposite cart order deadlocked on the foreign key `BisOrderItem.productId → Product` (its `KEY SHARE` lock against `applyStockDelta`'s `FOR UPDATE`); S10 fixes it by inserting items in ascending product id (`checkout-stock.e2e-spec.ts` AS-34). The contract migration that drops that foreign key is still due (section E).
- **Importers adapted early (done in the first pass because T041 changed the event payload types and the monorepo must compile)**: `notifications/infra/notification-router.projector.ts`, `experimentation/infra/purchase-events.projector.ts`, `developer-platform/infra/webhook-router.projector.ts`, `seller-insights/infra/{leaderboard,shop-sales,shop-live}.projector.ts`, `payments/infra/settlement.listener.ts` (field reads only), and the payload builders in `notifications.e2e-spec.ts`, `webhooks.e2e-spec.ts`, `leaderboards.e2e-spec.ts`, `finance.e2e-spec.ts`. `discovery/infra/order-baskets.projector.ts` needed no change. Their owners confirm or redo the change.

## Deferred until a later pass

First implementation pass (priority P1 and the Setup and Foundational phases; US1 to US4 are built). Nothing below waits for an unbuilt capability except where a capability is named; everything else waits only for its priority.

| Story / scenarios | What is not built | Waits for |
|---|---|---|
| **US5 (P2)** AS-55 | the API matrix for `POST /orders/:id/cancel` on `PAID`/`FULFILLING`/`SHIPPED`/`DELIVERED`/`REFUNDED` (`409` with `currentStatus`), `400` for a bad id, `401`, and the 50-run pay-vs-cancel hook (the race itself is proven by AS-51). The route and its happy path (AS-40) exist; AS-54 (unit), AS-56 and AS-57 are proven in the Foundational phase | priority (P2 pass) |
| **US6 (P2)** AS-58 to AS-63 | `GET /orders` (keyset history, covering index), `GET /orders/:orderId`, `GET /shops/:shopId/orders`, `OrderQueryService.getOrdersForShop`, `getOrderLines`, `getPayableOrder`, the `OrderQueryService`/`TooManyIdsError` barrel exports. **The old `GET /orders` and `GET /orders/:orderId` routes were removed with the old controller and are not served until this pass** (the new `OrderQueryService.getOrderForUser` exists and backs the cancel answer) | priority (P2 pass). Its only external dependency is S12 for the export join, which stays untouched |
| **US7 (P3)** AS-64 to AS-68 | `order-events.e2e-spec.ts` (envelope parse of every transition, atomic rollback with `503` on an outbox failure, realtime down, logs and metrics, jobs twice on two instances, inbox purge at 35 days), job types `orders.purge-webhook-inbox` and `orders.backfill-item-titles` and the title backfill, `orders-boundary.e2e-spec.ts` and the `index.ts` pin of the TRANSITIONAL block, replacing the raw `Product` SQL in `infra/flash-sale.jobs.ts` by `applyStockDelta` (`check:table-ownership` for `orders` is 2 findings today: this one and the S12 export join), moving flash files into `infra/flash/`, `OrderQueryService` export. Partly done on the way: `OrderService` shrunk to `transition`, `index.ts` rewritten with a marked TRANSITIONAL block, the direct `sequelize.transaction` of `order.jobs.ts` migrated (count 1 → 0), importers adapted (T081, see above, not ticked) | priority (P3 pass); flash replacement also waits for S11 for anything beyond the minimal change |
| **Phase 10 (Polish)** | T084 to T090: deleting obsolete files, whole-capability run, gap audit, UNVERIFIED reconciliation, recorded run | final pass |

**Capabilities not built that the implemented stories touch** (built as far as they can be, degrading as the spec says; nothing faked outside the specs' own edges):

- **S13 payments** (no `.implemented` marker): `PaymentStatusPort` is bound to `PaymentStatusUnavailableAdapter`, which fails closed with a retryable error, so a provider success is stored, retried 8 times and ends `FAILED` (AS-44); `payments.events` has no producer, so the consumer idles; `orders.refund_requested` has no consumer, the message waits in the outbox/queue. Specs register a contract-valid fake of the port, and build consumer messages by hand.
- **S45 discounts**: the default `LegacyCheckoutDiscountsAdapter` converts the old per-line `CheckoutDiscounts` result when shop-functions is bound; with none bound there are no discounts (catalogue prices).
- **S11 flash sales / S21 auctions / S12 exports**: untouched behaviour (parked as described above).
- **S01, S03, S05, S49, S50, S52, S53, S54 are built and used as planned.** The e2e kit loads `OrdersJobsModule` and a probe module for `PaymentsEventsConsumer` instead of `OrdersWorkerModule` (which also starts the Kafka consumer through `ProjectionsModule.forProjectors`); the specs call the job handlers and `consumer.project` directly, as the tenancy and catalog specs do.

## Gate repairs

- **S53 AS-09 (`libs/infrastructure/outbox/outbox-isolation.spec.ts`)**: the gate failed because `scripts/technical-table-scan.ts` still listed `libs/domains/orders/api/stripe-webhook.controller.ts` in `HANDED_OVER` (S10's raw SQL on `ProcessedWebhookEvent`). S10 replaced that SQL with `InboxService.claim`, so the entry was reported stale, which the test requires to be removed. Fix: removed the entry; in the spec the hand-over list is now the two remaining files (media-processor, catalog-import), and the "scan sees the table" check expects `Outbox` (the only table the two remaining files reference). No test deleted or skipped; the stale-entry check stays as strict as before. Re-run: `npx jest libs/infrastructure/outbox/outbox-isolation` 4/4 green, `npx tsc --noEmit` clean.
