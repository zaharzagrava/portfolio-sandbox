---
id: discount-tie-break
title: Discount tie-break by line position
kind: term
status: draft
aliases: [ties]
defined_for: S10-cart-checkout
rules_hash: 3568432ac3ee
---
# Discount tie-break by line position
## Definition
This rule settles ties when a [seller discount](seller-discount.md) is split across a shop's lines. The split uses the [largest-remainder method ↗](../sw-external-terms.md#largest-remainder-method), so whole [minor units](minor-units.md) can be left over after each line gets its rounded-down share. Those leftover units go to the lines with the largest remainders. When two lines have equal remainders, the line that comes first by position gets the unit first. Design intent (not stated in the spec): the same cart always produces the same split, so the line totals can be repeated and tested.

## Example
Illustrative values: a discount of `100` is split over three lines that each gross `1000`. Each exact share is 33.33…, so each line gets `33` and `1` unit is left over. All three remainders are equal, so the first line gets the unit. The shares are `34`, `33` and `33`.

## Known gaps
- The spec does not say what "[line position](line-position.md)" means. It could be [cart order](cart-line.md), `addedAt`, ascending `productId`, or position inside the [shop order](shop-order.md).
- Not confirmed in the code: the tie-break inside `allocateLargestRemainder` (`packages/backend/libs/domains/orders/domain/money-allocation.ts`). The rule cites that function, but I did not read its source.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-04
- [cart-line](cart-line.md)
- [line-position](line-position.md)
- [minor-units](minor-units.md)
- [seller-discount](seller-discount.md)
- [shop-order](shop-order.md)
- [shop-subtotal](shop-subtotal.md)
<!-- used-by:end -->
