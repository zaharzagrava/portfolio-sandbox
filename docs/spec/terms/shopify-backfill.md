---
id: shopify-backfill
title: Shopify backfill
kind: term
status: draft
aliases: [backfill]
defined_for: J04-catalog-sync-to-search
rules_hash: 1df5f1e0e4bc
---
# Shopify backfill
## Definition
The Shopify backfill is the first copy of a store's active variants into the catalog, run when the store is connected. Like every other product change, it goes through the catalog's [exported commands](exported-command.md). So each new or changed product raises [`productVersion`](product-version.md) and emits one [`catalog.product_*` event](catalog-product-events.md). Those events then bring the products into [public search](search-visibility.md).

## Example
A store with 7 active variants is connected by an owner with `integrations.manage`. After the backfill, the 7 variants exist as catalog products and are found by public product search.

## Known gaps
- The spec does not say whether the backfill runs synchronously or in the background, or how its progress is reported.
- The spec does not say what a reconnect or a retried backfill does, beyond the general rule that a change that changes nothing emits no event.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): B-05
- [shop-integration](shop-integration.md)
- [shopify-connection](shopify-connection.md)
- [shopify-import](shopify-import.md)
- [shopify-link](shopify-link.md)
- [shopify-variant](shopify-variant.md)
<!-- used-by:end -->
