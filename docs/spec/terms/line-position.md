---
id: line-position
title: Line position
kind: term
status: draft
aliases: [position]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# Line position
## Definition
Line position is where a [cart line](cart-line.md) sits in the list of lines being priced at checkout. Its only stated use is in the [discount tie-break](discount-tie-break.md): when lines have equal remainders under the [largest-remainder method ↗](../sw-external-terms.md#largest-remainder-method), the line that comes first gets the leftover [minor unit](minor-units.md) first. This makes line position the last deciding factor in how a [seller discount](seller-discount.md) is split. Design intent (not stated in the spec): a fixed order means the same cart always gets the same split, so line totals can be repeated and tested.

## Example
Illustrative values: a seller discount of `100` is split over three lines in one [shop order](shop-order.md), each with a gross of `1000`. Each line gets `33`, and that leaves `1` unit over. All three remainders are equal, so the line in the first position gets that unit. The shares are `34`, `33`, `33`.

## Known gaps
- The spec does not say what sets a line's position. It could be cart order, `addedAt`, ascending `productId` (the order used for stock operations), or the order inside the shop order.
- The spec does not say whether the position is counted across the whole cart or within each shop order.
- Not confirmed in the code: how `allocateLargestRemainder` in `packages/backend/libs/domains/orders/domain/money-allocation.ts` orders lines when breaking a tie. I didn't read its source.

## Used by
<!-- used-by:start -->
- [cart-line](cart-line.md)
- [discount-tie-break](discount-tie-break.md)
- [minor-units](minor-units.md)
- [seller-discount](seller-discount.md)
- [shop-order](shop-order.md)
<!-- used-by:end -->
