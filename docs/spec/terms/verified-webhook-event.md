---
id: verified-webhook-event
title: Verified webhook event
kind: term
status: draft
aliases: [webhook event]
defined_for: order-reservation
rules_hash: 4adc8b3e473e
---
# Verified webhook event
## Definition
A verified webhook event is a payment notification from the [payment provider](payment-provider.md) that the backend has confirmed is genuine. It is the only thing that can mark an order [`PAID`](order-status.md). The event's payment status, amount and currency must all match the order. If any of them differ, the event is stored as [`REJECTED`](rejected-payment-event.md) and the order is not marked paid.

## Example
A verified event reports a successful payment of 49.90 EUR for order `42` (illustrative). The order total is also 49.90 EUR, so the order becomes `PAID`. If the event had said 49.90 USD, it would be stored as `REJECTED`.

## Known gaps
- The spec does not say how the webhook is verified, for example which signature scheme is used.
- The spec does not say what happens to the order after a `REJECTED` event. `REJECTED` is not an order status, so it appears to be the status of the stored event.
- The spec does not say what happens when a verified event arrives for an order that is already [`CANCELLED`](order-status.md), such as one cancelled with [`hold_expired`](hold-expired.md).

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-25, R-31, R-32, B-16
- [order-reservation](../concepts/order-reservation.md): C-07
- [hold-expired](hold-expired.md)
- [ignored-payment-event](ignored-payment-event.md)
- [order-status-history](order-status-history.md)
- [order-version](order-version.md)
- [orders-domain](orders-domain.md)
- [paid-mark](paid-mark.md)
- [payment-provider](payment-provider.md)
- [post-webhooks-stripe](post-webhooks-stripe.md)
- [rejected-payment-event](rejected-payment-event.md)
- [unmatched-payment-event](unmatched-payment-event.md)
- [verify-stripe-signature](verify-stripe-signature.md)
- [webhook-secret](webhook-secret.md)
<!-- used-by:end -->
