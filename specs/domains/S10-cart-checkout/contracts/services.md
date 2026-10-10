# Service contract (R1) and ports: S10 — `orders`

## Exported from `@app/domains/orders`

| Export | Kind | Consumers |
|---|---|---|
| `OrdersModule` (core), `OrdersWorkerModule` (worker) | Nest modules | apps |
| `OrderQueryService` | R1 provider | S13, S42, S21, S31, S16, S43 |
| `OrderFulfilmentService` | R1 provider | S19, S20 |
| `OrderNotFoundError`, `OrderNotPayableError`, `InvalidOrderTransitionError`, `TooManyIdsError` | errors (each with a stable `code`) | callers above |
| types `OrderStatus`, `ShopOrderStatus`, `PayableOrderDto`, `ShopOrderDto`, `OrderLineDto`, `OrderCommand`, `ReservationSource` | types | S11 (`ReservationSource`), others |
| `OrderReserved`, `OrderPaid`, `OrderCancelled`, `OrderRefunded`, `OrderFulfilmentChanged` | event definitions | consumers (S19, S28, S31, S34, S36, S40, S43, J01) |
| `ordersRatePolicies` | policy table | rate-limit specs, global modules |

**TRANSITIONAL block** in `index.ts` (kept so other capabilities still build; pinned by `orders-boundary.e2e-spec.ts` so it can only shrink; each line is deleted when its last importer converts): `BisOrderModel`, `BisOrderScope`, `BisOrderItemModel`, `ShopOrderModel`, `StockReservationModel`, `FlashSaleModel`, `OrderService` (compat, see research D-1), `FlashStockService`, `OrderExportService`, `ExportJobTopicsModule`, `CheckoutDiscounts`, `DiscountableLine`, `CreateBisOrderDto`, `ORDER_MODELS`, `BisOrderWithAllFilters`.

## `OrderQueryService`

- `getOrdersForShop(shopId, { status?, limit? ≤ 100, cursor? }) → { items: ShopOrderDto[], nextCursor: string | null }` — predicate `shopId` on every joined table; deterministic order `(createdAt DESC, id DESC)`.
- `getOrderLines(orderIds ≤ 500) → Map<OrderId, OrderLineDto[]>` — one statement; unknown ids absent; > 500 → `TooManyIdsError`.
- `getPayableOrder(orderId, userId) → PayableOrderDto { orderId, userId, totalMinor, currency, reservedUntil, shopAllocations:[{shopId, subtotalMinor}] }` — `WHERE id = :id AND userId = :u`; foreign and missing → `OrderNotFoundError`; not `RESERVED` or `reservedUntil <= now` → `OrderNotPayableError {orderId, status, code: 'order_not_reserved' | 'hold_expired'}`. Time from the injected clock.

## `OrderFulfilmentService`

`apply(orderId, { type: 'startFulfilment' } | { type: 'ship', trackingCode } | { type: 'deliver' }) → { status, orderVersion }`; guard = the same `OrderLifecycleService.transition` as every other trigger; throws `InvalidOrderTransitionError {orderId, currentStatus, command}`, `OrderNotFoundError`; emits `order.fulfilment_changed`.

## Internal ports (`domain/ports.ts`, tokens exported from `domain/`)

| Port | Adapter (`infra/`) | Default / fake |
|---|---|---|
| `OrderRepository`, `ReservationRepository`, `OrderHistoryRepository`, `CartStore`, `CheckoutLock` | Sequelize / Dynamo / Redis | — |
| `ProductCatalogPort` (`getProducts(ids)`, `applyStock(ops)`) | wraps `ProductQueryService`, `ProductStockService` with 1 s / 2 s timeouts, maps `rejected` failures to `out_of_stock` / `product_unavailable` | — |
| `ShopDirectoryPort` (`getShops(ids)`) | wraps `ShopQueryService.getShopsByIds` | — |
| `PaymentStatusPort.getPaymentStatus(paymentRef)` | wraps S13 `PaymentQueryService` when it exists | `PaymentStatusUnavailableAdapter` (retryable error) until S13 |
| `ShopDiscountsPort.evaluate(cart)` | `LegacyCheckoutDiscountsAdapter` over `CheckoutDiscounts`; timeout 250 ms, validation, fallback counter | none bound → `[]` |
| `ReservationSource` (`reserve`, `release`, `convert`) | `CatalogReservationSource` | S11 adds flash sources |
| `RealtimePort.pushOrderStatus` | wraps `RealtimePublisher`, errors counted | — |
| `RefundCommandPort.requestRefund` | outbox/SQS producer of `orders.refund_requested` | — |
| `Clock` | `CLOCK` token | `FakeClock` in specs |

## Jobs (S49 `declareJobType`, handlers in `infra/order.jobs.ts`)

| Type | Trigger | Options |
|---|---|---|
| `orders.expire-reservation` | per order at `reservedUntil` | `concurrency: 50` |
| `orders.sweep-expired-reservations` | every 60 s | `concurrency: 1, fleetConcurrency: 1`, ≤ 200 per run, `SKIP LOCKED` |
| `orders.recover-pending` | every 30 s | `fleetConcurrency: 1`, `PENDING` older than 60 s |
| `orders.release-stock` | every 30 s | per-row backoff (`nextReleaseAt`), `fleetConcurrency: 1` |
| `orders.clear-cart` | per order | `maxAttempts: 5` |
| `orders.process-webhook` | per inbox event | `maxAttempts: 8`, backoff 5 s × 2ⁿ cap 10 min, full jitter, dead letter on the last failure |
| `orders.purge-webhook-inbox` | daily | `InboxService.purge(now − 35 d)`, `fleetConcurrency: 1` |
| `orders.backfill-item-titles` | at worker boot until done | `fleetConcurrency: 1`, batches of 200 |

## Metrics (`domain/order-metrics.ts`)

`orders_checkout_total{outcome}`, `orders_reservation_expired_total`, `orders_reservations_release_pending` (gauge), `orders_webhook_events_total{result}`, `orders_discount_fallback_total{reason}`, `orders_cart_cleanup_failed_total`, `orders_paid_after_cancel_total`, `orders_realtime_failed_total`, `orders_backfill_orphans` (gauge). No user, order or product label.

## Config keys (validated at startup, S54)

`cart_cookie_secret` (required, ≥ 32 bytes), `stripe_webhook_secret` (required), `stripe_webhook_secret_previous` (optional), `orders_hold_seconds` (900), `orders_cart_max_lines` (50), `orders_cart_max_quantity` (20), `orders_cart_line_ttl_days` (30), `orders_catalog_timeout_ms` (1000), `orders_stock_timeout_ms` (2000), `orders_discount_timeout_ms` (250), `orders_checkout_budget_ms` (10000), `orders_webhook_max_attempts` (8), `orders_clear_cart_max_attempts` (5), `orders_inbox_retention_days` (35), `orders_webhook_body_limit_bytes` (65536).
