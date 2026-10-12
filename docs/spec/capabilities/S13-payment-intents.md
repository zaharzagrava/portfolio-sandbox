---
id: S13
title: Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S10, S50, S51, S53, S54, S49]
concepts: [idempotency-key, outbox-task-queue, payment-lifecycle, order-reservation, rate-limit-policy, realtime-topic-stream, problem-json-errors, transaction-runner, job-scheduler-lease]
models: [payment-status, charge-delivery]
scope:
  - packages/backend/libs/domains/orders/**
  - packages/backend/libs/domains/payments/**
  - packages/contracts/src/payments/**
---
# S13 - Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders

## Purpose
A buyer with a reserved order pays for it. The platform records one payment per order, asks the payment provider (PSP) to charge it asynchronously, and tells the buyer and the order system the result. The capability MUST never charge twice, never lose a charge, and never let a slow or silent provider stop the rest of the platform. See {{concept:payment-lifecycle}} and {{concept:order-reservation}}.

## Entry points
- `POST /payments/intents`: an authenticated buyer starts payment of a reserved order. It needs an `Idempotency-Key` ({{concept:idempotency-key}}) and answers `202` with `Location`. It never calls the provider. [code: packages/backend/libs/domains/payments/api/payment.controller.ts#PaymentController]
- `GET /payments/:paymentId`: the owner reads one payment. A foreign or unknown ID answers `404 payment_not_found`. [code: packages/backend/libs/domains/payments/api/payment.controller.ts#PaymentController]
- `GET /payments`: the owner lists their payments with a signed keyset cursor, newest first. [code: packages/backend/libs/domains/payments/domain/payment-cursor.ts#encodePaymentCursor]
- Queue `payments-charge`: one charge command per accepted payment, sent from the outbox after commit; the processor consumes it. [code: packages/backend/libs/domains/payments/application/payment-intent.service.ts#CHARGE_QUEUE]
- Queue `orders-refund-requested`: the order system asks for a full refund of a completed payment. [code: packages/backend/libs/domains/payments/application/refund-request.service.ts#REFUND_QUEUE]
- Topic `orders.events` (`order.reserved`, `order.paid`, `order.cancelled`): feeds the local order copy and cancels payments that have not started charging. [code: packages/backend/libs/domains/payments/infra/orders-events.consumer.ts#OrdersEventsConsumer]
- `PaymentQueryService.getPaymentStatus(paymentRef)`: status service for the order system, with a provider refresh. [code: packages/backend/libs/domains/payments/application/payment-query.service.ts#PaymentQueryService]
- Periodic sweep, every 60 s: resolves due `UNKNOWN` payments ({{concept:job-scheduler-lease}}).

## Rules
- **S13.R-01** The amount and currency of a payment MUST come from the order copy; a body with `amountMinor`, `currency`, `userId`, a card field or any unknown property answers `400 validation_failed`. [proof: S13 AS-02] [code: packages/backend/libs/domains/payments/domain/payment-amount.ts#checkPaymentMoney]
- **S13.R-02** `amountMinor` MUST be an integer from 1 to 99,999,999 (else `422 amount_out_of_range`), and the currency MUST be `EUR`, `USD` or `GBP`. [proof: none] [code: packages/backend/libs/domains/payments/domain/payment-amount.ts#checkPaymentMoney]
- **S13.R-03** An order is payable only when it belongs to the caller, is `RESERVED`, and `now < reservedUntil`; at `now == reservedUntil` the hold is expired (`409 order_not_payable`, reason `order_cancelled`, `order_paid` or `hold_expired`). [proof: S13 AS-11] [code: packages/backend/libs/domains/payments/domain/order-copy.ts#checkPayable]
- **S13.R-04** A foreign order and an unknown order MUST answer the same `404 order_not_found`; an unauthenticated or guest-only caller gets `401`. [proof: S13 AS-10, S13 AS-12] [code: packages/backend/libs/domains/payments/domain/payment-errors.ts#OrderNotFoundError]
- **S13.R-05** One payment MUST exist per order, enforced by the store; the loser of a race gets `409 payment_already_exists` with `existingPaymentId`. [proof: S13 AS-06] [code: packages/backend/libs/domains/payments/domain/payment-errors.ts#PaymentAlreadyExistsError]
- **S13.R-06** `Idempotency-Key` is mandatory; the same key with the same body replays the stored `202` with `Idempotency-Replayed: true`; the same key with another body answers `422 idempotency_key_reuse`; a missing key answers `422 idempotency_key_required`. [proof: S13 AS-03, S13 AS-07]
- **S13.R-07** A request with the same key while the first runs MUST answer `409 idempotency_in_flight` with `Retry-After: 1`. [proof: S13 AS-04, S13 AS-05]
- **S13.R-08** Keys are scoped per buyer, and only a `202` is remembered; failures before a payment exists and `5xx` answers leave the key usable. [proof: S13 AS-08, S13 AS-09]
- **S13.R-09** `POST /payments/intents` is limited to 10 per buyer per minute and fails closed when the limiter store is down ({{concept:rate-limit-policy}}). [proof: S13 AS-14] [code: packages/backend/libs/domains/payments/rate-limit-policies.ts#paymentsRatePolicies]
- **S13.R-10** The payment, its history row, the charge command and the idempotency record MUST be written in one transaction, and no provider call or publish happens inside a transaction ({{concept:transaction-runner}}). [proof: S13 AS-46, S13 AS-45]
- **S13.R-11** The provider idempotency reference for a charge MUST be the order ID, for a refund `refund:<paymentId>`, and for a cancel `cancel:<paymentId>`. [proof: S13 AS-15, S13 AS-47, S13 AS-50]
- **S13.R-12** The processor MUST re-check that the order is payable before calling the provider; if not, the payment is `CANCELLED` (`order_not_payable`) with 0 provider calls. [proof: S13 AS-19]
- **S13.R-13** A provider success whose amount, currency, status or `orderId` metadata does not match MUST NOT complete the payment; it becomes `UNKNOWN`. [proof: S13 AS-22] [code: packages/backend/libs/domains/payments/domain/provider-outcome.ts#findMismatch]
- **S13.R-14** A definite decline MUST make the payment `FAILED` (for example `card_declined`); a rejected request (`400`, `401`) makes it `FAILED(provider_rejected)`. [proof: S13 AS-16, S13 AS-18] [code: packages/backend/libs/domains/payments/domain/provider-outcome.ts#classifyCharge]
- **S13.R-15** A timeout or `5xx` after a charge was sent MUST make the payment `UNKNOWN`, and the charge MUST NOT be sent again. [proof: S13 AS-23, S13 AS-31]
- **S13.R-16** A redelivered charge command MUST NOT create a second provider charge; a recorded attempt without a result becomes `UNKNOWN(crash_recovery)`. [proof: S13 AS-20, S13 AS-30]
- **S13.R-17** `UNKNOWN` payments are settled by a lookup by our reference; the payment becomes `COMPLETED`, `FAILED` or `PENDING` as the provider shows, and stays `UNKNOWN` when the provider is unreachable. [proof: S13 AS-24, S13 AS-25, S13 AS-27, S13 AS-28]
- **S13.R-18** When the lookup finds no record, the payment stays `UNKNOWN` until 60 minutes after the attempt began. [proof: S13 AS-26]
- **S13.R-19** Each provider operation has its own breaker; only timeouts, connection errors, `5xx`, `429` and calls over 5 s count as failures, and declines do not. [proof: S13 AS-31, S13 AS-32, S13 AS-33, S13 AS-38]
- **S13.R-20** Every status change MUST be one guarded update on status and version, with one history row and a version step of 1; terminal statuses are never revisited. [proof: S13 AS-39, S13 AS-40, S13 AS-41, S13 AS-42] [code: packages/backend/libs/domains/payments/domain/payment-status.ts#decide]
- **S13.R-21** A cancellation applies only while no charge attempt is recorded; cancel and charge start are mutually exclusive. [proof: S13 AS-43, S13 AS-48, S13 AS-49]
- **S13.R-22** Events leave only through the outbox in the same transaction as the status change ({{concept:outbox-task-queue}}). [proof: S13 AS-45]
- **S13.R-23** A refund request MUST refund a `COMPLETED` payment exactly once; it waits while the payment is `UNKNOWN` or `PENDING` with an attempt. [proof: S13 AS-50, S13 AS-51, S13 AS-52, S13 AS-53, S13 AS-54]
- **S13.R-24** Every status change publishes `payment.status` to the owner's topic only; a push failure MUST NOT affect the transition ({{concept:realtime-topic-stream}}). [proof: S13 AS-61]
- **S13.R-25** Payment code MUST read and write only tables owned by payments. [proof: S13 AS-64]

## Behaviors
- **S13.B-01** Given a reserved order and a new key, when the buyer posts `{orderId, paymentMethodId}`, then the answer is `202` with `Location`, status `PENDING`, and one charge command in the outbox. [proof: S13 AS-01]
- **S13.B-02** Given a completed first request, when the same key and body arrive again, then the original `202` returns byte for byte and nothing new is created. [proof: S13 AS-03]
- **S13.B-03** Given five identical concurrent requests, then every answer is `202` with one `paymentId` or `409 idempotency_in_flight`, and one payment and one command exist. [proof: S13 AS-05]
- **S13.B-04** Given two requests with different keys for one order, then one answers `202` and the other `409 payment_already_exists`. [proof: S13 AS-06]
- **S13.B-05** Given buyer V uses the same key as buyer U, then V gets a new payment. [proof: S13 AS-08]
- **S13.B-06** Given an order whose event has not arrived, when it arrives within 2 s, then the post answers `202`; otherwise `404 order_not_found`. [proof: S13 AS-12]
- **S13.B-07** Given a buyer who made 10 requests in a minute, when the 11th arrives, then it answers `429 rate_limited` and creates nothing. [proof: S13 AS-14]
- **S13.B-08** Given the provider answers "succeeded", then the processor calls create once and the payment becomes `COMPLETED` with a ledger posting and a `payment_succeeded` event. [proof: S13 AS-15]
- **S13.B-09** Given a card decline, then the payment is `FAILED(card_declined)` with no ledger entry and one `payment_failed` event. [proof: S13 AS-16]
- **S13.B-10** Given the provider needs customer action, then the payment stays `PENDING` with `requiresAction`, with no event. [proof: S13 AS-17]
- **S13.B-11** Given the provider does not answer within 8 s, then the payment is `UNKNOWN(provider_timeout)` and no event goes to orders. [proof: S13 AS-23]
- **S13.B-12** Given an `UNKNOWN` payment and a succeeded provider intent, then the resolution completes it through the same guarded step. [proof: S13 AS-24]
- **S13.B-13** Given 10 of 10 charge calls fail with `503` in 10 s, then the 10 payments are `UNKNOWN` and the breaker opens; after 30 s one probe is allowed. [proof: S13 AS-31, S13 AS-32]
- **S13.B-14** Given the provider is down and breakers are open, then `POST /payments/intents` and `GET /payments/:id` still answer within 300 ms. [proof: S13 AS-37]
- **S13.B-15** Given a charge refused by an open breaker, when the provider recovers before the 3rd attempt, then the charge runs and the payment is `COMPLETED`. [proof: S13 AS-34, S13 AS-35]
- **S13.B-16** Given `order.cancelled` for a `PENDING` payment with no attempt, then the payment is `CANCELLED(order_cancelled)` with 0 provider calls. [proof: S13 AS-48]
- **S13.B-17** Given `order.cancelled` for a payment waiting for the customer, then the provider intent is cancelled once and the payment is `CANCELLED`. [proof: S13 AS-47]
- **S13.B-18** Given `orders.refund_requested` for a `COMPLETED` payment, then it becomes `REFUND_PENDING`, then `REFUNDED` with a reversing journal. [proof: S13 AS-50]
- **S13.B-19** Given the order system asks for a status by provider reference, then it gets a mapped status; a pending payment is refreshed from the provider within 2 s. [proof: S13 AS-55, S13 AS-56]
- **S13.B-20** Given a buyer reads another buyer's payment, then the answer is `404 payment_not_found`, identical to a missing one. [proof: S13 AS-57]

## Lifecycles
Statuses: `PENDING`, `UNKNOWN`, `COMPLETED`, `FAILED`, `CANCELLED`, `REFUND_PENDING`, `REFUNDED`. The accept path creates `PENDING`; the charge processor, the resolution job, order events and the refund worker move the rest. See [payment-status](../models/payment-status.md) and [charge-delivery](../models/charge-delivery.md).

## Owns
- Tables: `Payment`, `PaymentHistory`, `PayableOrder` (the order copy), `LedgerEntry`.
- Queues: `payments-charge`, `orders-refund-requested` (with a dead-letter queue).
- Events: `payments.payment_succeeded`, `payments.payment_failed`, `payments.payment_refunded`; realtime `payment.status`.
- Configuration: provider key and secrets, timeouts, breaker thresholds, retry and backoff parameters, rate limits ([code: packages/backend/libs/common/config/payments-config.ts#PaymentsConfig]).

## Decisions
- The accept path reads a local order copy, so payment does not call orders and works when orders is slow.
- The charge runs asynchronously, so the HTTP surface does not depend on the provider.
- A timeout leaves the payment `UNKNOWN` and settles it by lookup, because a resend could charge twice.
- One retry layer (the charge retry) and no client network retries, so attempts stay countable (at most 6).
- Each operation has its own breaker, so a refund outage does not stop charges.
- Foreign and missing resources answer the same `404`, so existence cannot be probed.
- Terminal statuses are never revisited; contradictions are logged and left to reconciliation.

## Known gaps
- No test with a scenario id covers AS-13 (amount and currency limits), AS-58 (list pagination), AS-59 (list scoping), AS-60 (read rate limit), AS-62 (metrics), AS-63 (no secrets), AS-65 (startup validation) or AS-66 (graceful shutdown); R-02 has no proof.
- AS-57 (read one) is the only P2 read scenario with a test; the list, the read limit (120 per minute, fail open) and the 24-hour `UNKNOWN` warning are unproven.
- The 24-hour refund alarm and the refund retry cap are described in the specification but no test is tied to them in these facts.
- AS-64 records that earlier code queried the catalog's table and referenced orders by foreign key; the facts do not show whether this is fully removed.