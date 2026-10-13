---
id: shop-deleted-event
title: tenancy.shop_deleted event
kind: term
status: draft
aliases: [tenancy.shop_deleted]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# tenancy.shop_deleted event
## Definition
`tenancy.shop_deleted` is an event published by the tenancy domain when a shop has been deleted. The catalog consumes it and deletes the shop's products, [status history](product-status-history.md) and [stock operations](stock-operation.md). The deletion runs in [bounded transactions](bounded-batch.md). For each product it writes one [`catalog.product_deleted` event](catalog-product-deleted-event.md), with a [`productVersion`](product-version.md) one above that product's last version. [The purge can run again](catalog-shop-purge.md) after any interruption, and it never touches other shops.

## Example
`tenancy.shop_deleted` arrives for a shop with 1,200 products. The catalog deletes them in transactions of at most 500 products and writes 1,200 `catalog.product_deleted` events. Products of other shops are left unchanged.

## Known gaps
- The spec does not say whether the purge also drops the shop's cache entries or its stored shop status.
- The spec does not say how a rerun finds where it stopped. It says only that the purge can run again after an interruption.

## Used by
<!-- used-by:start -->
- [bounded-batch](bounded-batch.md)
- [catalog-product-deleted-event](catalog-product-deleted-event.md)
- [catalog-shop-purge](catalog-shop-purge.md)
- [product-status-history](product-status-history.md)
- [stock-operation](stock-operation.md)
<!-- used-by:end -->
