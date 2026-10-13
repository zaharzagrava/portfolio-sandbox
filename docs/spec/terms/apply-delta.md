---
id: apply-delta
title: applyDelta
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# applyDelta
## Definition
`applyDelta` is the stock rule in the [catalog domain layer](catalog-domain-layer.md). It takes a product's current stock and a [stock delta](stock-delta.md), and returns the new quantity or a refusal. It refuses any result below zero or above the [stock upper bound](stock-upper-bound.md). [`ProductStockService`](product-stock-service.md) calls it inside [`applyStockDelta`](apply-stock-delta.md). Keeping the rule apart from the database code makes it easy to test on its own. This is design intent (not stated in the spec).

## Example
Current stock 5, delta `-1` → new quantity 4 (illustrative).
Current stock 0, delta `-1` → refused, and the caller of `applyStockDelta` gets [`insufficient_stock`](insufficient-stock.md).

## Known gaps
- Not confirmed in the code: whether `applyDelta` is a pure function, or whether it also reads or writes the stock operation record.
- The spec does not say which error is returned when a delta would push stock above the upper bound. `insufficient_stock` is only shown for going below zero.
- Not confirmed in the code: whether [idempotency by `operationId`](stock-operation-id.md) is handled in `applyDelta` or only in `ProductStockService`.

## Used by
<!-- used-by:start -->
- [catalog-domain-layer](catalog-domain-layer.md)
- [stock-delta](stock-delta.md)
- [stock-operation-id](stock-operation-id.md)
- [stock-upper-bound](stock-upper-bound.md)
<!-- used-by:end -->
