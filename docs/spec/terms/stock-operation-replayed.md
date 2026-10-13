---
id: stock-operation-replayed
title: replayed flag
kind: term
status: draft
aliases: [replayed, replayed: true]
defined_for: S05-products
rules_hash: 8ca1c453b08a
---
# replayed flag
## Definition
`replayed` is a flag in the result of [`applyStockDelta`](apply-stock-delta.md). It is `true` when the [`operationId`](stock-operation-id.md) was already applied. In that case the [delta](stock-delta.md) is not applied again, and the result repeats the original outcome, including the original [`quantityAfter`](quantity-after.md). This lets callers retry a stock operation safely.

## Example
A caller sends `applyStockDelta` with `operationId` `op-123` (illustrative) and the operation applies. A network retry sends `op-123` again. The result has `replayed: true` and the same `quantityAfter` as the first call, and stock does not change.

## Known gaps
- The spec does not say whether the first application returns `replayed: false` or leaves the flag out.
- The spec does not say what happens when an already-used `operationId` comes back with a different product or delta.
- The spec does not say what happens to a replay that arrives after the [purge job](idempotency-purge-job.md) has deleted the operation record. The record is gone, so the operation might be applied a second time.

## Used by
<!-- used-by:start -->
- [idempotency-purge-job](idempotency-purge-job.md)
- [product-stock-service](product-stock-service.md)
- [stock-delta](stock-delta.md)
<!-- used-by:end -->
