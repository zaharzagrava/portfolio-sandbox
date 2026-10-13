---
id: payment-cancel
title: Payment cancel
kind: term
status: draft
aliases: [cancel:<paymentid>]
defined_for: S13-payment-intents
rules_hash: 416370a1fc71
---
# Payment cancel
## Definition
A payment cancel asks the payment provider to cancel a [provider intent](payment-intent.md) that was already created. It happens when [`order.cancelled`](order-cancelled-event.md) arrives for a payment that is waiting for customer action. The intent is cancelled once, using the reference [`cancel:<paymentId>`](provider-idempotency-reference.md), and the payment becomes `CANCELLED`. This is different from cancelling a [`PENDING`](payment-status.md) payment that has no [attempt](checkout-attempt.md) yet. That case is handled locally, with no provider call. A cancel and the start of a charge are [mutually exclusive ↗](../sw-external-terms.md#mutual-exclusion).

## Example
A payment is `PENDING` with [`requiresAction`](requires-action.md), and `order.cancelled` arrives. The platform calls the provider's cancel once with `cancel:pay_7` (illustrative), and the payment becomes `CANCELLED`.

## Known gaps
- The spec does not say how this fits with S13.R-21, which allows a cancellation only while no charge attempt is recorded. A payment waiting for the customer seems to have an attempt already.
- The spec does not say what happens when the provider cancel times out or its [breaker ↗](../sw-external-terms.md#circuit-breaker) is open.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-11
- [checkout-attempt](checkout-attempt.md)
- [payment-intent](payment-intent.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
<!-- used-by:end -->
