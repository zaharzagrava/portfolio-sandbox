---
id: put-cart-items
title: PUT /cart/items/:productId
kind: term
status: draft
aliases: [/cart/items/:productid]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# PUT /cart/items/:productId
## Definition
`PUT /cart/items/:productId` is the route that sets the quantity of one cart line in the caller's cart. It replaces the quantity rather than adding to it, and quantity `0` removes the line. The route takes no cart ID. A signed-in caller always writes to the [user cart](cart.md), and a signed-out caller writes to the [guest cart](guest-cart.md). For a guest, the first write issues the [guest cart token cookie](guest-cart-token.md). Each write counts toward the [cart rate limit](rate-limit.md), and setting a line starts its [line expiry](line-expiry.md) period again.

## Example
A signed-out visitor calls `PUT /cart/items/p-123` with quantity 3, then calls it again with quantity 5 (the product ID and body shape are illustrative). The line now holds 5, not 8. The first call also issued the guest cart cookie. A later call with quantity `0` removes the line. A 21st quantity, or a 121st cart write within a minute, is refused: the write limit returns [`429 rate_limited`](rate-limited.md) with [`Retry-After` ↗](../sw-external-terms.md#retry-after).

## Known gaps
- The spec does not say what the success response contains, or which error is returned for an out-of-range quantity or for a new line beyond the [cart line limit](cart-line-limit.md).
- The spec does not say whether the route checks that `productId` exists, or that the product is available, before it stores the line.
- The spec does not say what happens when a guest sends a token that fails verification. The cart then counts as "no cart", but the spec does not say whether a new cookie is issued.

## Used by
<!-- used-by:start -->
- [cart-line-limit](cart-line-limit.md)
- [cart](cart.md)
- [guest-cart-token](guest-cart-token.md)
- [guest-cart](guest-cart.md)
- [line-expiry](line-expiry.md)
- [rate-limit](rate-limit.md)
<!-- used-by:end -->
