---
id: orders-refund-requested-event
title: orders.refund_requested event
kind: term
status: draft
aliases: [orders-refund-requested, orders.refund_requested]
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# orders.refund_requested event
## Definition
`orders.refund_requested` is the message the order system sends to ask payments for a full refund of a completed payment. It arrives on the `orders-refund-requested` queue, which payments owns, and the [refund worker](refund.md) consumes it. A `COMPLETED` payment moves to [`REFUND_PENDING`](payment-status.md), then to `REFUNDED`, and a [reversing journal](reversing-journal.md) is written. The refund happens exactly once, even if the message arrives more than once. If the payment is still `UNKNOWN`, or `PENDING` with a charge attempt, the request waits rather than failing.

## Example
1. A payment is `COMPLETED`. The order system sends `orders.refund_requested` for it.
2. The refund worker calls the payment provider with the [provider idempotency reference](provider-idempotency-reference.md) `refund:<paymentId>`.
3. The payment becomes `REFUND_PENDING`, then `REFUNDED`, and a reversing journal is written.

## Known gaps
- The spec does not say whether `orders.refund_requested` is the message type on the `orders-refund-requested` queue or a separate event. The spec uses both names.
- The spec does not say what the message contains (payment ID, order ID or provider reference), or what happens when the payment is `FAILED`, `CANCELLED` or already `REFUNDED`.
- The spec does not say when a message goes to the [dead-letter queue ↗](../sw-external-terms.md#dead-letter-queue), or how long a waiting refund request is retried.

## Used by
<!-- used-by:start -->
- [provider-idempotency-reference](provider-idempotency-reference.md)
- [refund](refund.md)
- [reversing-journal](reversing-journal.md)
<!-- used-by:end -->
