---
id: refund
title: Refund
kind: term
status: draft
aliases: [refund request]
defined_for: payment-lifecycle
rules_hash: 04eabaf1c729
---
# Refund
## Definition
A refund gives a buyer back the money from a payment that has already been charged. A refund request MUST refund a [`COMPLETED`](payment-status.md) payment [exactly once ↗](../sw-external-terms.md#idempotency), so repeating the request never sends money back twice. While the payment is [`UNKNOWN`](unknown-payment-outcome.md), or `PENDING` with [an attempt in progress](checkout-attempt.md), the refund request waits. Design intent (not stated in the spec): the charge might still go through, so refunding now could refund nothing or race with the charge. When the order system receives a full [`charge.refunded`](verified-webhook-event.md), it refunds a [`PAID`](order-status.md) or `FULFILLING` order.

## Example
The buyer's payment for an order is `COMPLETED`, and the order is `PAID`. A refund request refunds the payment once, and a repeated request does not refund it again. When the full `charge.refunded` result arrives, S10 moves the order to refunded.

## Known gaps
- The spec does not say what happens to a refund request for a payment that is `CANCELLED` or failed.
- The spec does not say whether partial refunds exist, or which status a payment takes after it is refunded.
- The spec does not say how a waiting refund is resumed after the payment leaves `UNKNOWN` or `PENDING`, or whether the refund request must carry an `Idempotency-Key`.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): B-19
- [S13](../capabilities/S13-payment-intents.md): R-23
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-08
- [checkout-attempt](checkout-attempt.md)
- [decide-payment-status](decide-payment-status.md)
- [order-not-cancellable](order-not-cancellable.md)
- [orders-refund-requested-event](orders-refund-requested-event.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
- [reversing-journal](reversing-journal.md)
- [terminal-payment-status](terminal-payment-status.md)
<!-- used-by:end -->
