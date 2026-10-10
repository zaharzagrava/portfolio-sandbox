# Event contract: S10 — `orders`

Topic `orders.events`, key `orderId`, registered with `aggregateType: 'orders'` (retention `full-history`, per-order ordering). Envelope (S53): `{eventId, type, version: 1, occurredAt, aggregateId: orderId, aggregateVersion}`; **every payload carries `orderVersion`**, the order's `version` after the move, strictly increasing per order. Written through `OutboxService.append` inside the transition's transaction (III.3, IV.4). Money fields end in `Minor`. Schemas: `packages/contracts/src/orders/order-events.ts` (`orderEventSchemas`), imported by the definitions.

| Type (exported definition) | Payload |
|---|---|
| `order.reserved` (`OrderReserved`) | `{orderId, userId, totalMinor, currency, shopIds: ShopId[], reservedUntil, orderVersion}` |
| `order.paid` (`OrderPaid`) | `{orderId, userId, totalMinor, currency, paymentRef, paidAt, lines:[{productId, shopId, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}], shopOrders:[{shopOrderId, shopId, subtotalMinor}], orderVersion}` |
| `order.cancelled` (`OrderCancelled`) | `{orderId, userId, reason: 'out_of_stock'\|'payment_failed'\|'hold_expired'\|'user_cancelled', previousStatus, orderVersion}` |
| `order.refunded` (`OrderRefunded`) | `{orderId, userId, amountMinor, currency, reason, orderVersion}` (full refunds only; partial refunds are a history row) |
| `order.fulfilment_changed` (`OrderFulfilmentChanged`) | `{orderId, status: 'FULFILLING'\|'SHIPPED'\|'DELIVERED', trackingCode?, orderVersion}` |

`out_of_stock` cancellations emit `order.cancelled` (`previousStatus: PENDING`) but no `order.reserved`. Exactly one event per transition; a rolled-back transition leaves no row (AS-64).

## Single-consumer message

`orders.refund_requested` v1 `{orderId, paymentRef, amountMinor, currency, reason: 'order_cancelled'}` (SQS, via the S53 task producer, group key `orderId`). Producer: `WebhookProcessorService` / `PaymentResultService` when a genuine success meets a `CANCELLED` order; deduplicated on `paymentRef` (outbox/task idempotency key `refund:<paymentRef>`). Consumer: S13.

## Consumed

| Topic | Types | Schema | Idempotency (IV.5) | Poison |
|---|---|---|---|---|
| `payments.events` (key `paymentId`) | `payments.payment_succeeded`, `payments.payment_failed`, `payments.payment_refunded` v1 `{paymentId, paymentRef, orderId, userId, amountMinor, currency, occurredAt}` | `paymentEventSchemas` (zod, `packages/contracts/src/orders/payment-events.ts`; S13 may take ownership) | guarded transitions are idempotent (already-applied → no-op) plus inbox `recordOnce('orders.payment-results', eventId)` in the effect's transaction | schema failure → DLQ via the S53 framework, next message continues |
| Stripe webhook (HTTP) | `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`; all others `IGNORED` | zod envelope `{id, type, data.object.metadata.orderId, amount, currency}` | `InboxService.claim('stripe', event.id)` | `400 invalid_payload` before storing |

## Consumers of our events and what they must adopt

S19 (`order.paid` → dispatch), S31 (`order.paid` → entitlement), S28 (all → mails/popover), S34 (`order.paid` lines), S36 (conversion), S40 (leaderboards, sales), S43 (webhook router `order.*`), S14/S16 (R3 CDC, not these events), J01. In-repo importers affected by the rename today are listed in `gaps.md` → Sibling-spec follow-ups.
