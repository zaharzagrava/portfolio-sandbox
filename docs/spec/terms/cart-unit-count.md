---
id: cart-unit-count
title: Unit count (cart badge)
kind: term
status: draft
aliases: [unit count]
defined_for: W03-cart-checkout-orders
rules_hash: 24749a4d6f10
---
# Unit count (cart badge)
## Definition
The unit count is the number shown on the [cart badge](cart-badge.md). It counts units in the cart, so a line with quantity 3 adds 3. It does not count distinct lines; the [cart line limit](cart-line-limit.md) counts those instead. Above a set ceiling the badge shows a capped label in place of the exact number. Until the count is known, the badge shows nothing at all.

## Example
A cart has a line with quantity 3 and a line with quantity 1, so the badge shows `4` (illustrative values).
A cart holding 120 units shows `99+` (rule W03.R-01).

## Known gaps
- The spec does not say whether [lines marked "No longer available"](cart-line.md) count toward the unit count.
- The spec does not say whether the count comes from the cart read or is worked out in the browser.

## Used by
<!-- used-by:start -->
- [W03](../capabilities/W03-cart-checkout-orders.md): R-01
- [cart-badge-display-ceiling](cart-badge-display-ceiling.md)
- [cart-badge](cart-badge.md)
- [cart-line-limit](cart-line-limit.md)
- [cart-line](cart-line.md)
<!-- used-by:end -->
