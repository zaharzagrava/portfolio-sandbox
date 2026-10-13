---
id: cart-badge-display-ceiling
title: Cart badge display ceiling
kind: term
status: draft
aliases: [cap, display ceiling]
defined_for: W03-cart-checkout-orders
rules_hash: e3b0c44298fc
---
# Cart badge display ceiling
## Definition
The display ceiling is the highest [unit count](cart-unit-count.md) that the [cart badge](cart-badge.md) shows as an exact number. When the cart's unit count is above the ceiling, the badge shows a fixed capped label in place of the real number. Only the badge display is capped. The cart and its unit count keep the real value. Design intent (not stated in the spec): the cap keeps the badge short and the same width in the [navbar](navbar.md).

## Example
Under W03.R-01, a cart with 99 units shows `99` on the badge. A cart with 120 units (an illustrative number) shows `99+`. A cart whose count is still loading shows no badge.

## Known gaps
- The spec does not say what screen readers announce for the capped label. Accessibility ([AS-74](acceptance-scenario.md)) has no test.
- Not confirmed in the code: the UI source files aren't in the file list, so this page can't tell you where the ceiling is defined or whether it can be configured.

## Used by
<!-- used-by:start -->
- [acceptance-scenario](acceptance-scenario.md)
- [cart-badge](cart-badge.md)
- [cart-unit-count](cart-unit-count.md)
- [navbar](navbar.md)
<!-- used-by:end -->
