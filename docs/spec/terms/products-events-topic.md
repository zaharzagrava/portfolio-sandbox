---
id: products-events-topic
title: products.events topic
kind: term
status: draft
aliases: [products.events]
defined_for: S05-products
rules_hash: af06360dadc5
---
# products.events topic
## Definition
`products.events` is the topic on the [event backbone](event-backbone.md) where [S05](../capabilities/S05-products.md) publishes its product events. It carries `catalog.product_created`, `catalog.product_updated`, `catalog.product_archived`, `catalog.product_restored` and `catalog.product_deleted`. Every committed product change writes one versioned event in the same transaction, through [the outbox](inbox-table.md). [A no-op update](no-op-update.md) writes no event. [The cache invalidator](cache-invalidator.md) consumes this topic to repair cache deletes that were lost after a write.

## Example
A member sends `PATCH /shops/:shopId/products/:productId` with `expectedVersion: 3`, and the price changes. The same transaction moves the product to version 4 and writes one `catalog.product_updated` event row. The outbox relay then publishes it on `products.events`. (Version numbers are illustrative.)

## Known gaps
- The spec does not say which consumers read `products.events` besides the cache invalidator.
- The spec does not say which flow emits `catalog.product_deleted`. The product lifecycle only allows `ACTIVE ⇄ ARCHIVED`, and no delete endpoint is listed.
- The spec does not say what the event payload contains, apart from the product version.

## Used by
<!-- used-by:start -->
- [cache-invalidator](cache-invalidator.md)
- [capability](capability.md)
- [catalog-product-deleted-event](catalog-product-deleted-event.md)
- [event-backbone](event-backbone.md)
- [inbox-table](inbox-table.md)
- [no-op-update](no-op-update.md)
<!-- used-by:end -->
