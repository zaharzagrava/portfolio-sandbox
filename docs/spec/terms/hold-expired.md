---
id: hold-expired
title: hold_expired cancellation
kind: term
status: draft
aliases: [hold expiry]
defined_for: order-reservation
rules_hash: 6df23cccce7d
---
# hold_expired cancellation
## Definition
`hold_expired` is the cancellation reason for an order that held stock but was never paid. When an order is still [`RESERVED`](order-status.md) at its [`reservedUntil`](reserved-until.md) time, the backend cancels it with this reason. The order's held stock is then returned [exactly once](stock-release.md) through a [stock release](stock-release.md). In the web app the order shows only as "Cancelled".

## Example
A buyer checks out at 10:00 (illustrative). The order becomes `RESERVED` with `reservedUntil` at 10:15. No [verified webhook event](verified-webhook-event.md) arrives, so at 10:15 the order becomes `CANCELLED(hold_expired)` and its stock goes back.

## Known gaps
- The spec does not say which job or mechanism notices the expiry and cancels the order, or how late it may run.
- The spec does not say what happens when a verified webhook event for a payment arrives after the order was cancelled with `hold_expired`.
- The spec does not say whether the web app ever shows the cancellation reason. Only the status label "Cancelled" is listed.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-22, B-13
- [order-version](order-version.md)
- [orders-domain](orders-domain.md)
- [stock-operation-id](stock-operation-id.md)
- [stock-release](stock-release.md)
- [verified-webhook-event](verified-webhook-event.md)
<!-- used-by:end -->
