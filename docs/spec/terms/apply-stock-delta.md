---
id: apply-stock-delta
title: applyStockDelta
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# applyStockDelta
## Definition
`applyStockDelta` is the exported command on [`ProductStockService`](product-stock-service.md) that other domains use to change a product's stock. They may not write stock in any other way. Each call is [all-or-nothing](all-or-nothing-reservation.md) and [idempotent ↗](../sw-external-terms.md#idempotency) by its [`operationId`](stock-operation-id.md), so a retried call returns the first result with [`replayed: true`](stock-operation-replayed.md) and does not apply the change twice. It refuses any change that would take stock below zero or above the [stock ceiling](stock-upper-bound.md). The arithmetic and bounds check are in [`applyDelta`](apply-delta.md) in the stock rule.

## Example
Stock is 5 and ten concurrent calls each send `-1`. Five succeed, five get [`insufficient_stock`](insufficient-stock.md), and stock ends at 0.
Sending an already applied `operationId` again returns its original result:
```json
{ "replayed": true, "quantityAfter": 4 }
```
(the [`quantityAfter`](quantity-after.md) value is illustrative)

## Known gaps
- The spec does not say which error a call gets when it would push stock above the ceiling. `insufficient_stock` is only shown for going below zero.
- The spec does not say what happens if an `operationId` is retried after the [purge job](idempotency-purge-job.md) has deleted its operation record. The call might then be applied a second time.
- The spec does not say whether one call can change several products at once, or what "all-or-nothing" covers in that case.

## Used by
<!-- used-by:start -->
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [idempotency-purge-job](idempotency-purge-job.md)
- [stock-upper-bound](stock-upper-bound.md)
<!-- used-by:end -->
