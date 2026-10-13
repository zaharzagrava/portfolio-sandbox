---
id: added-at
title: addedAt
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# addedAt
## Definition
`addedAt` is a timestamp stored on each cart line. Its main use is during a [cart merge](cart-merge.md), where it decides the order of [guest-only lines](guest-cart.md). The user's own lines always survive the merge. Guest-only lines are then added in `addedAt` order, with [`productId`](product-id.md) breaking ties, until the [cart line limit](cart-line-limit.md) is reached. Guest lines that don't fit are counted in [`droppedLines`](dropped-lines.md).

## Example
The user's cart already holds 49 lines. The guest cart has two lines the user cart doesn't: product `A` (`addedAt` 09:00) and product `B` (`addedAt` 09:05). Times are illustrative. The merge keeps `A`, leaves out `B`, and reports `droppedLines: 1`.

## Known gaps
- The spec does not say whether the order is ascending (oldest first) or descending. The example assumes oldest first.
- The spec does not say whether `addedAt` changes when a line's quantity is set again. It also does not say whether `addedAt` is the "last set" time that the [line expiry](line-expiry.md) uses.

## Used by
<!-- used-by:start -->
- [cart-line-limit](cart-line-limit.md)
- [cart-merge](cart-merge.md)
- [guest-cart](guest-cart.md)
- [line-expiry](line-expiry.md)
<!-- used-by:end -->
