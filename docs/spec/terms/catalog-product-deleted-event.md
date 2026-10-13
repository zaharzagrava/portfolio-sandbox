---
id: catalog-product-deleted-event
title: catalog.product_deleted event
kind: term
status: draft
aliases: [catalog.product_deleted]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# catalog.product_deleted event
## Definition
`catalog.product_deleted` is one of the product events that [S05 (product service)](../capabilities/S05-products.md) publishes on [the topic `products.events`](products-events-topic.md). Like every product event, it is written in [the same transaction as the change it reports](outbox-append.md) and carries [the product version](product-version.md). The [cache invalidator](cache-invalidator.md) consumes `products.events`. It deletes a product's [cache entry](cache-entry.md) only when the event's version is higher than the cached one. Deleting is not part of the product lifecycle, which only allows `ACTIVE ⇄ ARCHIVED`.

## Example
The cache invalidator receives `catalog.product_deleted` for a product whose cached entry has version 4. The event's version is 5, so the entry is deleted. A duplicate of the same event later changes nothing. (Version numbers are illustrative.)

## Known gaps
- The spec does not say which flow emits `catalog.product_deleted`. No delete endpoint or delete command is listed, and the lifecycle has no deleted status.
- The spec does not say whether this event is tied to the `tenancy.shop_deleted` consumer, for example when a shop's products are purged.
- The spec does not say what payload the event carries beyond the version that all product events have.

## Used by
<!-- used-by:start -->
- [cache-entry](cache-entry.md)
- [cache-invalidator](cache-invalidator.md)
- [outbox-append](outbox-append.md)
- [product-version](product-version.md)
- [products-events-topic](products-events-topic.md)
<!-- used-by:end -->
