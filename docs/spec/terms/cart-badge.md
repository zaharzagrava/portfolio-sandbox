---
id: cart-badge
title: Cart badge
kind: term
status: draft
aliases: [badge]
defined_for: W03-cart-checkout-orders
rules_hash: 30493193d1ab
---
# Cart badge
## Definition
The cart badge is the small indicator on the cart icon that appears on every page. It shows how many items are in the cart, but it never shows more than a fixed upper limit. It stays hidden until that number is known, so it never shows a guessed or zero value while the cart is loading. It updates after [**Add to cart**](add-to-cart-signal.md) and becomes empty once an order is placed.

## Example
A visitor with no cart sees no badge number (W03.B-01). They press **Add to cart**, and the badge updates (W03.B-02). After [**Place order**](post-checkout.md) gets a [`202` ↗](../sw-external-terms.md#http-202-accepted) answer, the badge is empty again (W03.B-09).

## Known gaps
- The spec does not say whether the badge updates live from [the stream](stream-connection.md) or only when the cart is read again.

## Used by
<!-- used-by:start -->
- [W03](../capabilities/W03-cart-checkout-orders.md): B-01, B-02
- [add-to-cart-signal](add-to-cart-signal.md)
- [cart-badge-display-ceiling](cart-badge-display-ceiling.md)
- [cart-unit-count](cart-unit-count.md)
- [post-checkout](post-checkout.md)
- [stream-connection](stream-connection.md)
<!-- used-by:end -->
