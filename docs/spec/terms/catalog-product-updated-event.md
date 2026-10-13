---
id: catalog-product-updated-event
title: catalog.product_updated event
kind: term
status: draft
aliases: [catalog.product_updated]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# catalog.product_updated event
## Definition
`catalog.product_updated` is the product event that [S05](../capabilities/S05-products.md) writes when an update actually changes a product. S05 publishes it on the `products.events` topic. It is written through [the outbox](outbox-append.md) in the same transaction as the product change, so it exists only if the change commits. The event carries the new product version. The [product cache invalidator](invalidate.md) consumes it and deletes the cache entry only when the event's version is higher than the cached one. A [no-op update](no-op-update.md) writes no such event.

## Example
A `PATCH /shops/:shopId/products/:productId` sends `[expectedVersion](expected-version.md): 3` and changes the price from `1999` to `2499` [minor units](minor-units.md). The answer is `200` with `version: 4`. In the same transaction, S05 writes one `catalog.product_updated` event that carries version 4. The invalidator then deletes the cached entry held at version 3. If the same event arrives again, nothing changes. (The prices and versions are illustrative.)

## Known gaps
- The spec does not say which fields the event payload contains besides the product version.
- The spec does not say whether stock changes through `applyStockDelta` or updates through `upsertFromExternal` emit `catalog.product_updated` or some other event.
- The spec does not say whether archive and restore emit only `catalog.product_archived` and `catalog.product_restored`, or `catalog.product_updated` as well.

## Used by
<!-- used-by:start -->
- [invalidate](invalidate.md)
- [minor-units](minor-units.md)
- [no-op-update](no-op-update.md)
- [outbox-append](outbox-append.md)
<!-- used-by:end -->
