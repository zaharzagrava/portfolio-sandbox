---
id: insufficient-stock
title: insufficient_stock
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# insufficient_stock
## Definition
`insufficient_stock` is the result [`ProductStockService.applyStockDelta`](apply-stock-delta.md) gives when a [delta](stock-delta.md) would take a product's stock below zero. [The operation is refused as a whole](all-or-nothing-reservation.md), so stock stays as it was. When several [operations run concurrently](stock-operation.md) on the same product, those that still fit apply and the rest get `insufficient_stock`. Stock never goes negative.

## Example
Stock is 5 and ten concurrent operations each send a delta of `-1`. Five of them apply and five return `insufficient_stock`. Stock ends at 0.

## Known gaps
- The spec does not say whether `insufficient_stock` is thrown as an error or returned as a result value, or which HTTP status it maps to if it reaches a client.
- The spec does not say which code is returned when a delta would push stock above the [upper bound](stock-upper-bound.md).
- The spec does not say how `insufficient_stock` relates to [`out_of_stock`](out-of-stock-error.md).

## Used by
<!-- used-by:start -->
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [stock-delta](stock-delta.md)
- [stock-operation](stock-operation.md)
- [stock-upper-bound](stock-upper-bound.md)
<!-- used-by:end -->
