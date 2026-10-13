---
id: cart
title: Cart
kind: term
status: draft
aliases: [user cart]
defined_for: S10-cart-checkout
rules_hash: e8e8bfded4cb
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
- [S10](../capabilities/S10-cart-checkout.md): B-02, B-03
- [user-prefix](user-prefix.md)
<!-- used-by:end -->
