---
id: cart
title: Cart
kind: term
status: draft
aliases: [user cart]
defined_for: S10-cart-checkout
rules_hash: 226d1edfc4f2
---
# Cart
## Definition
A cart is the list of cart lines a buyer collects before checkout. Each cart belongs to exactly one identity: either a signed-in user or a guest with a signed cookie. No route takes a cart ID. The caller's identity always picks the cart. After login, `POST /cart/merge` moves the guest cart into the user's cart. Checkout turns the cart into one order.

## Example
A signed-in user who still has a guest cookie calls `PUT /cart/items/A`. The line goes into the user's cart. The guest cart and its cookie stay unchanged until a merge.

## Known gaps
- The spec does not say what happens to a guest cart that is never merged, apart from its lines expiring.

## Used by
<!-- used-by:start -->
- [line-expiry](line-expiry.md)
- [put-cart-items](put-cart-items.md)
- [user-prefix](user-prefix.md)
<!-- used-by:end -->
