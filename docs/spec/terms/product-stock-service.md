---
id: product-stock-service
title: ProductStockService
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# ProductStockService
## Definition
`ProductStockService` is the catalog service that owns stock changes. Other domains may change a product's stock only through its exported command, [`applyStockDelta`](apply-stock-delta.md). It records each [stock operation](stock-operation.md) under its [operation ID](stock-operation-id.md), so a retried call is [replayed](stock-operation-replayed.md) instead of being applied twice. The arithmetic and bounds check are delegated to [`applyDelta`](apply-delta.md) in the [catalog domain layer](catalog-domain-layer.md). It reads stock from the database, never from the [product cache](cache-entry.md).

## Example
Stock is 5 and ten concurrent `applyStockDelta` calls each send `-1`. Five apply, five get [`insufficient_stock`](insufficient-stock.md), and stock ends at 0.
Sending an already applied `operationId` again returns the original result:
```json
{ "replayed": true, "quantityAfter": 4 }
```
(the [`quantityAfter`](quantity-after.md) value is illustrative)

## Known gaps
- The spec does not say whether a stock change increments the product version, writes a product event or deletes the product's cache entry.
- The spec does not say whether `applyStockDelta` is refused on a [`SUSPENDED`](shop-status.md) or `DELETING` shop, as product writes are.
- The spec does not say what happens if an `operationId` is retried after the [purge job](idempotency-purge-job.md) has deleted its operation record. The change might then be applied a second time.

## Used by
<!-- used-by:start -->
- [cache-entry](cache-entry.md)
- [catalog-domain-layer](catalog-domain-layer.md)
- [idempotency-purge-job](idempotency-purge-job.md)
- [stock-operation-id](stock-operation-id.md)
- [stock-operation-replayed](stock-operation-replayed.md)
- [stock-operation](stock-operation.md)
<!-- used-by:end -->
