---
id: quantity-after
title: quantityAfter
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# quantityAfter
## Definition
`quantityAfter` is the product's stock quantity right after a stock operation applied, as returned by `applyStockDelta`. On a replay it is the value saved from the first application, not the current stock. Callers should treat it as "stock when my operation applied", not as live stock.

## Example
Stock is 10 and operation `op-7` applies `-3`, which returns `quantityAfter: 7`. Another order then takes stock to 6. Sending `op-7` again returns `replayed: true` and still `quantityAfter: 7`. (All values are illustrative.)

## Known gaps
- The spec does not say whether an operation covering several products returns one `quantityAfter` per product.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
