---
id: stock-upper-bound
title: Stock upper bound
kind: term
status: draft
aliases: [upper bound]
defined_for: S05-products
rules_hash: 50cd88b2051a
---
# Stock upper bound
## Definition
The stock upper bound is the largest stock quantity a product may hold. [`applyStockDelta`](apply-stock-delta.md) refuses any [stock delta](stock-delta.md) that would take stock above it, and stock stays as it was. Together with the zero floor, it keeps stock inside a fixed range. Design intent (not stated in the spec): the bound keeps stock arithmetic far from integer overflow and blocks absurd values.

## Example
Stock is 999,999,999 (illustrative), and a [stock operation](stock-operation.md) sends a delta of `+2`. The result would be 1,000,000,001, which is above the 1,000,000,000 bound, so the operation is refused as a whole and stock stays at 999,999,999.

## Known gaps
- The spec does not say which code or result `applyStockDelta` returns when the upper bound is exceeded. The only result it names is [`insufficient_stock`](insufficient-stock.md), for the lower bound.
- The spec does not say whether the "out-of-limit stock" that create and update bodies refuse is checked against this same bound.
- Not confirmed in the code: the bound check is assumed to live in [`packages/backend/libs/domains/catalog/domain/stock-rule.ts#applyDelta`](apply-delta.md), but the facts show only that S05.R-19 links there.

## Used by
<!-- used-by:start -->
- [apply-delta](apply-delta.md)
- [apply-stock-delta](apply-stock-delta.md)
- [insufficient-stock](insufficient-stock.md)
- [stock-delta](stock-delta.md)
- [stock-operation](stock-operation.md)
<!-- used-by:end -->
