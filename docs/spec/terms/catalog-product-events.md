---
id: catalog-product-events
title: catalog.product_* events
kind: term
status: draft
aliases: [catalog.product_*]
defined_for: S05-products
rules_hash: 4c801bcc3fc7
---
# catalog.product_* events
## Definition
`catalog.product_*` is the family of [versioned events](event-definition.md) the catalog writes about products, such as `catalog.product_created`, `catalog.product_updated` and `catalog.product_deleted`. Every committed product change writes exactly one of these events, in the same transaction, [through the outbox](outbox-append.md). Every event carries the product's [`isSandbox` flag](is-sandbox.md). Other domains hold only a plain `productId`, not a [foreign key ↗](../sw-external-terms.md#foreign-key) to `Product`. They follow these events to clean up their own data.

## Example
When the [shop backfill](search-backfill-shop-state.md) gives a [legacy product](legacy-seller.md) its owner's shop, the catalog writes one `catalog.product_updated` for that product. When a shop is [purged](shop-purge.md), each of its products gets one `catalog.product_deleted`, with [`productVersion`](product-version.md) one above its last version.

## Known gaps
- The spec does not list the full set of event names. The list of owned events is cut off after `catalog.product_created`.
- The spec does not say that these events are published on the [`products.events` topic](products-events-topic.md), where the [cache invalidator](cache-invalidator.md) listens. That link is likely but not confirmed.
- The spec does not say what other domains must do when they receive `catalog.product_deleted`.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-25
- [S32](../capabilities/S32-product-search.md): R-13
- [cache-invalidator](cache-invalidator.md)
- [event-definition](event-definition.md)
- [is-sandbox](is-sandbox.md)
- [legacy-seller](legacy-seller.md)
- [outbox-append](outbox-append.md)
- [products-events-topic](products-events-topic.md)
- [search-backfill-shop-state](search-backfill-shop-state.md)
- [shop-purge](shop-purge.md)
<!-- used-by:end -->
