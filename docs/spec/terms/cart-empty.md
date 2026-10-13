---
id: cart-empty
title: cart_empty (422)
kind: term
status: draft
aliases: [cart_empty]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# cart_empty (422)
## Definition
`cart_empty` is the `422` error code that [`POST /checkout`](post-checkout.md) returns when the buyer's cart has no lines. No order is placed. It is one of the [checkout validation errors](error-code.md), alongside [`product_unavailable`](product-unavailable.md).

## Example
A buyer with an empty cart sends `POST /checkout` with a valid [`Idempotency-Key`](idempotency-key.md). The response is `422` with code `cart_empty`.

## Known gaps
- The spec does not say whether a [cart whose lines have all expired](cart-line.md) counts as empty.
- The spec does not say whether this failure happens before an order exists. That decides whether the [idempotency key is released for reuse](idempotency-key.md).

## Used by
<!-- used-by:start -->
- [cart-line](cart-line.md)
- [error-code](error-code.md)
- [idempotency-key](idempotency-key.md)
<!-- used-by:end -->
