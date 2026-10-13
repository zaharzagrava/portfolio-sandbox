---
id: cart-merge
title: Cart merge
kind: term
status: draft
aliases: [merge, merges, post /cart/merge]
defined_for: S10-cart-checkout
rules_hash: 97918ce7c662
---
# Cart merge
## Definition
Cart merge moves a buyer's guest cart into their user cart after they sign in. The client starts it with `POST /cart/merge`, which also clears the guest cookie. Each product ends up on one line with the quantities added together, up to the per-line quantity cap. The merged cart is capped in lines. User lines always stay, guest-only lines fill the remaining space, and `droppedLines` reports how many guest lines did not fit. Guest quantities are added exactly once, even when several merges run at the same time.

## Example
The user cart is `{A: 1, B: 19}` and the guest cart is `{A: 3, B: 5, C: 2}`. After `POST /cart/merge`, the cart is `{A: 4, B: 20, C: 2}` and the cookie is cleared. B is capped at 20.

## Known gaps
- The spec does not say whether the guest cart is deleted on the server or only becomes unreachable when the cookie is cleared.
- The spec does not say what merge returns when the caller has no guest cookie or an invalid one.
- The spec does not say whether expired guest lines are skipped before merging. A safe guess is that they are, because an expired line is never returned.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-06, B-03, B-04
- [W03](../capabilities/W03-cart-checkout-orders.md): R-06, B-06
- [added-at](added-at.md)
- [cart-line-limit](cart-line-limit.md)
- [dropped-lines](dropped-lines.md)
- [line-expiry](line-expiry.md)
<!-- used-by:end -->
