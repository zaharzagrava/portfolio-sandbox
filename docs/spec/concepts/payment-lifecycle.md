---
id: payment-lifecycle
title: Payments and their lifecycle
kind: concept
status: draft
defined_by: S13
---
# Payments and their lifecycle
## Definition
A payment is the platform's single record of one charge for one reserved order. The platform asks the payment provider (PSP) to charge it asynchronously, then reports the result to the buyer and the order system. Each payment moves through guarded statuses and ends in a terminal status. The guarantee: the platform never charges twice, never loses a charge, and never lets a slow or silent provider stop the rest of the platform.

## Rules
- **payment-lifecycle.C-01** One payment MUST exist per order, enforced by the store; its amount and currency MUST come from the [order copy](../terms/order-copy.md), never from the request body.
- **payment-lifecycle.C-02** A payment request MUST carry an [`Idempotency-Key`](../terms/idempotency-key.md); the same key and body replay the stored `202`, and the same key with another body answers [`422 idempotency_key_reuse`](../terms/idempotency-key.md).
- **payment-lifecycle.C-03** Before the [provider call](../terms/payment-provider.md), the [processor](../terms/payment-processor.md) MUST re-check that the order is [`RESERVED`](../terms/reservation-status.md) and `now < reservedUntil`; otherwise the payment is [`CANCELLED`](../terms/payment-status.md) with 0 provider calls.
- **payment-lifecycle.C-04** A timeout or `5xx` after a charge was sent MUST make the payment [`UNKNOWN`](../terms/unknown-payment-outcome.md), and the charge MUST NOT be sent again; a [redelivered command](../terms/at-least-once-delivery.md) MUST NOT create a second provider charge.
- **payment-lifecycle.C-05** A provider success whose amount, currency, status or [`orderId` metadata](../terms/provider-charge-metadata.md) does not match MUST NOT complete the payment; it becomes `UNKNOWN`.
- **payment-lifecycle.C-06** An [`UNKNOWN`](../terms/unknown-payment-outcome.md) payment MUST be settled by a [lookup by our reference](../terms/provider-lookup.md), and stays `UNKNOWN` when the provider is unreachable or finds no record within 60 minutes of the attempt.
- **payment-lifecycle.C-07** Every status change MUST be one [guarded update on status and version](../terms/guarded-update.md) with one [history row](../terms/payment-status-history.md); [terminal statuses](../terms/payment-status.md) MUST NOT be revisited, and events MUST leave only through the [outbox](../terms/inbox-table.md) in the same [transaction ↗](../sw-external-terms.md#database-transaction).
- **payment-lifecycle.C-08** A [refund request](../terms/refund.md) MUST refund a `COMPLETED` payment exactly once, and MUST wait while the payment is `UNKNOWN` or [`PENDING` with an attempt](../terms/checkout-attempt.md).

## How the capabilities use it
- {{cap:S10}} relies on payment results to move the order: a late failure after `PAID` MUST be ignored, `payment_failed` cancels a `RESERVED` order, and a full `charge.refunded` refunds a `PAID` or `FULFILLING` order.
- {{cap:S13}} defines the concept: payment intents, idempotency, unknown outcomes, the per-operation PSP circuit breaker, refunds and `payment.status` pushes to the owner's topic.
- {{cap:W03}} shows the payment to the buyer through the pay step phases `idle | tokenizing | submitting | processing | actionRequired | confirming | unknown | failed | completed | expired`, changed only by a pure reducer.

## Known gaps
- The S10 and W03 facts name the concept but state few rules. Their exact reaction to each payment status is not given.
- The facts do not say how a payment in `PENDING` after a lookup is resolved later.
- The facts give no mapping from payment statuses to the W03 pay step phases.

## Used by
<!-- used-by:start -->
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:W03}} Cart (guest and merged on login), checkout with idempotent submit and async payment status, success page, order history, notification popover
<!-- used-by:end -->
