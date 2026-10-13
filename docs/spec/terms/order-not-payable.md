---
id: order-not-payable
title: order_not_payable (409)
kind: term
status: draft
aliases: [order_not_payable]
defined_for: S13-payment-intents
rules_hash: b1256fbbfea8
---
# order_not_payable (409)
## Definition
`order_not_payable` is the `409` error returned when the buyer's order exists but cannot be paid right now. It always comes with a reason: `order_cancelled`, `order_paid` or [`hold_expired`](hold-expired.md). [The hold](all-or-nothing-reservation.md) counts as expired at the exact moment [`reservedUntil`](reserved-until.md) is reached, not only after it. The [payment processor](payment-processor.md) runs the same check again before it calls the provider. If the order is no longer payable at that point, the payment becomes [`CANCELLED`](payment-status.md) with reason `order_not_payable`, and the provider is not called.

## Example
```
reservedUntil = 2026-10-13T12:00:00Z, request arrives at 12:00:00Z   (illustrative)
→ 409 order_not_payable, reason hold_expired
```

## Known gaps
- The spec does not say which response member carries the reason.
- The spec does not say what is returned for an order in a status that matches none of the three reasons.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-12
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [payment-processor](payment-processor.md)
<!-- used-by:end -->
