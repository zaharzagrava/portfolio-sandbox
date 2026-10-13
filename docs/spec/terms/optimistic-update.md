---
id: optimistic-update
title: Optimistic update
kind: term
status: draft
aliases: [update the interface before the answer]
defined_for: W03-cart-checkout-orders
rules_hash: 302bd84cc101
---
# Optimistic update
## Definition
An optimistic update changes the screen before the server has answered. In [W03](../capabilities/W03-cart-checkout-orders.md) this applies to a quantity change on a [cart line](cart-line.md): the new quantity shows at once. Writes for the same product are sent one at a time, in the order the shopper made them, so a later change never lands before an earlier one. The design intent (not stated in the spec) is to make the cart feel instant while keeping [server state](source-of-truth.md) consistent with the last change.

## Example
A shopper presses **+** twice on a line at quantity 1. The line shows 2 and then 3 straight away. The browser sends the write for 2, waits for its answer and then sends the write for 3 (rule W03.R-03).

## Known gaps
- The spec does not say what the screen shows when an optimistic write fails, for example whether the quantity rolls back.
- The spec does not say whether writes for different products may be sent in parallel. It only orders writes for one product.

## Used by
<!-- used-by:start -->
- [W03](../capabilities/W03-cart-checkout-orders.md): R-03
- [cart-line](cart-line.md)
- [source-of-truth](source-of-truth.md)
<!-- used-by:end -->
