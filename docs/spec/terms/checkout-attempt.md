---
id: checkout-attempt
title: Attempt (one checkout try)
kind: term
status: draft
aliases: [one attempt]
defined_for: idempotency-key
rules_hash: 666b38f2d745
---
# Attempt (one checkout try)
## Definition
An attempt is one try by the user to place an order in the checkout UI (W03). Every retry within an attempt sends the same [`Idempotency-Key`](idempotency-key.md), including double presses and page reloads. The UI keeps the attempt in the tab's [session storage ↗](../sw-external-terms.md#session-storage), so a reload finds the same key again. This is why a double press or a reload produces one order.

## Example
A user presses "Place order", presses it again, then reloads the page and submits once more. All three [`POST /checkout`](post-checkout.md) requests carry the same key, so one order is created.

## Known gaps
- The spec does not say when an attempt ends and a new key is created, for example after a successful order or a change to the cart.
- The spec does not say what happens if the user checks out from a second tab. Session storage is per tab, so the second tab would most likely start a separate attempt.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-16, R-21
- [W03](../capabilities/W03-cart-checkout-orders.md): R-09, B-15
- [idempotency-key](../concepts/idempotency-key.md): C-06
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-08
- [crash-recovery](crash-recovery.md)
- [idempotency-key](idempotency-key.md)
- [orders-events-consumer](orders-events-consumer.md)
- [orders-events-topic](orders-events-topic.md)
- [payment-cancel](payment-cancel.md)
- [provider-lookup-window](provider-lookup-window.md)
- [refund](refund.md)
<!-- used-by:end -->
