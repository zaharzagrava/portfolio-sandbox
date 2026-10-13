---
id: payment-already-exists
title: payment_already_exists (409)
kind: term
status: draft
aliases: [existingpaymentid, payment_already_exists]
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# payment_already_exists (409)
## Definition
`payment_already_exists` is the [`409`](conflict-error.md) error returned when a payment already exists for the order. Only one payment may exist per order. [The store enforces this](durable-conditional-write.md), so when two requests race, exactly one wins. The losing request gets this error with `existingPaymentId`, which lets the client go to the payment that already exists. This error is for requests with different [idempotency keys](idempotency-key.md). Repeats of the same key are covered by [`idempotency_in_flight`](idempotency-in-flight.md) or by a [replay](idempotency-stored-answer.md).

## Example
Two tabs post for the same `orderId`, each with a different `Idempotency-Key`. One gets `202`. The other gets `409 payment_already_exists` with `existingPaymentId: "pay_123"` (illustrative).

## Known gaps
- The spec does not say whether a buyer whose payment for the order ended [`FAILED`](payment-status.md) can start a new payment, or whether this error blocks them.

## Used by
<!-- used-by:start -->
- [durable-conditional-write](durable-conditional-write.md)
- [idempotency-key](idempotency-key.md)
- [idempotency-stored-answer](idempotency-stored-answer.md)
<!-- used-by:end -->
