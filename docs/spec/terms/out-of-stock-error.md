---
id: out-of-stock-error
title: out_of_stock error
kind: term
status: draft
aliases: [out_of_stock]
defined_for: order-reservation
rules_hash: 7aaeda2fefff
---
# out_of_stock error
## Definition
The out_of_stock error is what the buyer receives when an [all-or-nothing reservation](all-or-nothing-reservation.md) fails because at least one line is short. It is sent as an HTTP unprocessable-entity response with the code `out_of_stock`. When the buyer sees this error, [no stock is held](reservation-status.md) and the order is already [`CANCELLED(out_of_stock)`](order-status.md).

## Example
The buyer submits checkout for a cart with one short line. The response is:
```
422 out_of_stock
```

## Known gaps
- The spec does not say the shape of the response body, or whether it lists the short lines.
- The spec does not say which endpoint returns it. [POST /checkout](post-checkout.md) is the likely one, but this is not confirmed.
- The spec does not say whether retrying with the same [idempotency key](idempotency-key.md) returns the same error.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): B-09
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [idempotency-key](idempotency-key.md)
- [post-checkout](post-checkout.md)
- [reservation-status](reservation-status.md)
<!-- used-by:end -->
