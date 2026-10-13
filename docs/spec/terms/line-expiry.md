---
id: line-expiry
title: Line expiry
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: d873bdb50ec9
---
# Line expiry
## Definition
Line expiry is the rule that a cart line lapses after a fixed period. The period counts from the last time the line's quantity was set. Once a line has expired, the system must not return it. The rule applies to every cart line, in a [user cart](cart.md) or a [guest cart](guest-cart.md). Setting the quantity again with `[PUT /cart/items/:productId](put-cart-items.md)` counts as setting the line, so the period starts over.

## Example
A buyer sets product `p-123` to quantity 2 on 1 March and never changes it again (the ID and date are illustrative). By 31 March the line has passed the 30-day expiry, so `[GET /cart](get-cart.md)` no longer includes it. If the buyer had set the quantity again on 20 March, the line would have stayed in the cart until 19 April.

## Known gaps
- The spec does not say whether an expired line is deleted from storage, or only hidden when the cart is read. It also names no job that removes expired lines.
- The spec does not say how expired lines are treated in a [cart merge](cart-merge.md), at checkout, or when counting toward the [cart line limit](cart-line-limit.md).
- Not confirmed in the code: S10.R-05 has no code reference, so where the expiry check runs is unknown.

## Used by
<!-- used-by:start -->
- [added-at](added-at.md)
- [cart-line-limit](cart-line-limit.md)
- [cart-merge](cart-merge.md)
- [cart](cart.md)
- [guest-cart](guest-cart.md)
- [put-cart-items](put-cart-items.md)
<!-- used-by:end -->
