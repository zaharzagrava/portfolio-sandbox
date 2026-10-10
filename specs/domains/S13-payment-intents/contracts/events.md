# Events and messages: S13 — `payments`

All events go through `OutboxService.append(event, tx)` inside the transition's transaction (IV.4), topic `payments.events`, message key = `paymentId`, envelope `{eventId, type, version: 1, occurredAt, aggregateId: paymentId}` (S53 `defineEvent`; `aggregateType: 'payments'`, retention `full-history`). Money fields end in `Minor`. Schemas: `packages/contracts/src/payments/payment-events.ts` (S13 owns; `orders/payment-events.ts` re-exports `paymentEventSchemas` so S10's imports keep working).

## Produced

| Event | Written when | Payload (every payload also has `paymentVersion: int`) |
|---|---|---|
| `payments.payment_succeeded` v1 | `→ COMPLETED` | `{paymentId, paymentRef: string, orderId, userId, amountMinor, currency, occurredAt}` |
| `payments.payment_failed` v1 | `→ FAILED` and `→ CANCELLED` | `{paymentId, paymentRef: string\|null, orderId, userId, amountMinor, currency, reasonCode, occurredAt}`; `reasonCode ∈ card_declined, insufficient_funds, expired_card, provider_rejected, provider_unavailable, provider_canceled, no_provider_record, order_not_payable, order_cancelled, declined_other` |
| `payments.payment_refunded` v1 | `→ REFUNDED` | `{paymentId, paymentRef, orderId, userId, amountMinor, currency, occurredAt}` |

Nothing is published for `UNKNOWN`, `PENDING` (including `awaitCustomer`) and `REFUND_PENDING`. Payloads are built field by field: never `paymentMethodId`, `clientSecret`, provider objects, error objects or stack traces (AS-63).

Consumers: S10 (`PaymentsEventsConsumer`, validates with `paymentEventSchemas`; amount/currency mismatch is permanent failure on its side), S28, S40, S14.

**Schema change versus the file S10 shipped** (additive within v1, V.7): `payment_failed.paymentRef` is nullable (failures before any provider call have no reference); `reasonCode` and `paymentVersion` are added; unknown keys are ignored by S10's zod objects.

## Internal task (outbox → queue)

`payments.charge_requested` v1 on queue `payments-charge` (FIFO, group = `paymentId`): `{paymentId: uuid, attempt: int ≥ 0}` written in the accept transaction. Consumer: `ChargeCommandWorker` (`TaskQueue.consume`, `bodySchema`; invalid → DLQ `payments-charge-dlq`, reason `invalid_payload`). Idempotent: `charge()` starts with the conditional `chargeAttemptedAt` update (research R-4); a second delivery finds the attempt recorded and either returns (result already applied) or marks `UNKNOWN(crash_recovery)`.

## Consumed

| Source | Type / queue | Handling | Idempotency | Invalid / unknown |
|---|---|---|---|---|
| `orders.events` (own consumer group `payments-order-copy`) | `order.reserved` / `order.paid` / `order.cancelled` v1 (`orderEventSchemas`) | `OrderCopyService.upsert` (version-guarded) and, for `order.cancelled`, `PaymentCancellationService.onOrderCancelled(orderId)` (cancel unattempted `PENDING`; cancel the provider intent for `requiresAction`; leave running/unknown alone — FR-035) | **version guard** on `PayableOrder.orderVersion` + conditional transitions | schema failure → `PermanentError` → DLQ (`payments_consumer_dead_lettered_total{reason="invalid_payload"}`); other `order.*` types → skipped by the framework |
| `orders-refund-requested` queue | `orders.refund_requested` v1 (`refundRequestedSchema`) | `RefundRequestService.handle` (research R-9) | payment state + job idempotency keys | `bodySchema` → DLQ `SCHEMA_INVALID`; `refund_amount_mismatch`, `refund_currency_mismatch`, `refund_ref_mismatch`, `payment_not_found`, `unsupported_reason` → explicit dead letter + `payments_consumer_dead_lettered_total{reason}` |

Refund handling by state: `COMPLETED` → `REFUND_PENDING` + job `payments.refund`; `REFUND_PENDING`/`REFUNDED` → ack, no effect; `FAILED`/`CANCELLED` → ack `nothing_to_refund`; `PENDING` without attempt → cancel (AS-48); `UNKNOWN` or attempted `PENDING` → durable wait job (`runAt` backoff), message acknowledged, alert at 24 h (`refund_wait_expired`).

## Retired

`payments.requests`, `payments.responses`, `payments.dlq`, the `payment.processed` carrier event (`PaymentProcessed`) and the `KafkaTopicGroup.payments.*` usage, `OutboxService.notify`, `KafkaConsumerService.consume` calls in payments (S53 follow-up; G-27's legacy consume path is then deletable by S53's owner — noted in `gaps.md` sibling bullets). `settlement.listener.ts` keeps consuming `order.paid` (S14), through a local event definition on the shared contract (no orders import).
