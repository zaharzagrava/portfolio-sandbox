---
id: line-total-minor
title: lineTotalMinor
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# lineTotalMinor
## Definition
`lineTotalMinor` is what one order line costs, stored as an integer in [minor units](minor-units.md). Checkout calculates it as [unit price](unit-price-minor.md) × quantity minus the line's share of the [seller discount](seller-discount.md), and it is never below zero. A [shop subtotal](shop-subtotal.md) is the sum of its line totals, and the [order total](order-total.md) is the sum of the shop subtotals. The [`orders.backfill-item-titles` job](orders-backfill-item-titles-job.md) also writes this field on older order items.

## Example
A line with a unit price of `1500`, quantity `2` and an allocated discount of `200`:
```json
{"unitPriceMinor": 1500, "quantity": 2, "lineTotalMinor": 2800}
```
The numbers are illustrative.

## Known gaps
- The spec does not say whether a backfilled `lineTotalMinor` subtracts the discount. The backfill describes it as unit price × quantity, which disagrees with S10.R-15 for discounted lines.
- Not confirmed in the code: that checkout writes the S10.R-15 line total into the field named `lineTotalMinor`. Only the backfill description names this field.

## Used by
<!-- used-by:start -->
- [minor-units](minor-units.md)
- [order-total](order-total.md)
- [orders-backfill-item-titles-job](orders-backfill-item-titles-job.md)
- [seller-discount](seller-discount.md)
- [shop-subtotal](shop-subtotal.md)
- [unit-price-minor](unit-price-minor.md)
<!-- used-by:end -->
