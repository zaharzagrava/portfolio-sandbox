---
id: guest-cart
title: Guest cart
kind: term
status: draft
aliases: []
defined_for: idempotency-key
rules_hash: 24c8087857d8
---
# Guest cart
## Definition
A guest cart is a cart that belongs to a shopper who has not logged in. It is owned by the same part of the system that handles the rest of the cart and checkout. When the guest logs in, that part of the system merges the guest cart into that user's cart. The checkout screens show the guest cart, and after login they show the merged cart.

## Example
A shopper who is not logged in adds two [cart lines](cart-line.md) to a guest cart (illustrative). They log in, and W03 now shows one cart with those lines merged into the user's cart. The shopper places the order from the merged cart through [`POST /checkout`](post-checkout.md).

## Known gaps
- The spec does not say how a guest cart is identified between requests. For example, it does not say whether it is keyed by [`X-Anonymous-Id`](x-anonymous-id.md).
- The spec does not say how the merge resolves conflicts, such as the same product in both the guest cart and the user's cart.
- The spec does not say how long a guest cart lives, or whether a guest can check out without logging in.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-01, B-01, B-04
- [W03](../capabilities/W03-cart-checkout-orders.md): B-05, B-06
- [added-at](added-at.md)
- [cart-line-limit](cart-line-limit.md)
- [cart-line](cart-line.md)
- [distinct-buyers-threshold](distinct-buyers-threshold.md)
- [dropped-lines](dropped-lines.md)
- [get-cart](get-cart.md)
- [guest-cart-token](guest-cart-token.md)
- [line-expiry](line-expiry.md)
- [put-cart-items](put-cart-items.md)
<!-- used-by:end -->
