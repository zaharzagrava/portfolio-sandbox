---
id: checkout-review-step
title: Checkout Review step
kind: term
status: draft
aliases: [review, review screen]
defined_for: W03-cart-checkout-orders
rules_hash: d10d1aa34f7c
---
# Checkout Review step
## Definition
The Review step is the screen a [signed-in member](shop-member.md) sees when they open `/checkout` with a non-empty cart. It lists the cart lines grouped by shop and shows the [estimated total](order-total.md). It also holds the [**Place order**](post-checkout.md) action. [Anonymous visitors](anonymous-state.md) never reach it: the server redirects them to sign-in before any checkout content is sent. If the cart is empty, the Review step is replaced by the "Your cart is empty" state, with no **Place order** button.

## Example
A member with two items from one shop opens `/checkout`. They see the Review step with a "Sold by {shop name}" group, the estimated total and **Place order**. They press it, get a `202`, and move to `/checkout/pay/{orderId}`.

## Known gaps
- The spec does not say what other steps exist besides Review. It names only this one and the separate pay screen at `/checkout/pay/{orderId}`.
- The spec does not say how the estimated total is computed. It also does not say why it is called "estimated". Design intent (not stated in the spec): the server may reprice when the order is placed, as `[409 price_changed](price-changed.md)` suggests.
- Not confirmed in the code: the UI source files are not in the file list, so the Review step is backed only by its acceptance scenario (W03 AS-15).

## Used by
<!-- used-by:start -->
- [W03](../capabilities/W03-cart-checkout-orders.md): B-07
- [anonymous-state](anonymous-state.md)
- [order-total](order-total.md)
- [post-checkout](post-checkout.md)
- [referral-code](referral-code.md)
- [shop-member](shop-member.md)
<!-- used-by:end -->
