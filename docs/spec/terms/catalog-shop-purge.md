---
id: catalog-shop-purge
title: Catalog shop purge
kind: term
status: draft
aliases: [purge, purge runs]
defined_for: S05-products
rules_hash: c1b88ddaf438
---
# Catalog shop purge
## Definition
The catalog shop purge runs when the catalog consumes `tenancy.shop_deleted`. It deletes that shop's products, their status history and their stock operations. It works in [bounded transactions](bounded-batch.md), and other shops are not touched. For each deleted product it writes one [`catalog.product_deleted`](catalog-product-deleted-event.md) event. The event's [`productVersion`](product-version.md) is one above the product's last version. Other domains keep a plain `productId` with [no foreign key ↗](../sw-external-terms.md#foreign-key), so they follow these events to clean up their own data. `ShopListingService` implements the purge. If it is interrupted, it can safely run again.

The version bump probably makes consumers that keep only versions above the stored one accept the delete as the newest change. That is design intent (not stated in the spec).

## Example
A shop with 1,200 products is deleted. The purge deletes them in transactions of at most 500 products (500, 500, 200). It writes 1,200 `catalog.product_deleted` events. A product whose last version was 7 gets an event with `productVersion: 8` (illustrative value).

## Known gaps
- The spec does not say whether the purge also deletes the shop's [`ProductShopState`](product-shop-state.md) or `ProductViewBatch` rows, or view counts still waiting to be flushed.
- The spec does not say whether the purge deletes the shop's product cache entries. Cache entries are only covered for `tenancy.shop_status_changed`.
- The spec does not say how a rerun after an interruption avoids writing a second `catalog.product_deleted` for a product that was already purged.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): B-21
- [bounded-batch](bounded-batch.md)
- [shop-deleted-event](shop-deleted-event.md)
- [tenancy-shop-events](tenancy-shop-events.md)
<!-- used-by:end -->
