---
id: shopify-variant
title: Shopify variant
kind: term
status: draft
aliases: [variant, variants]
defined_for: J04-catalog-sync-to-search
rules_hash: f65adaf0532a
---
# Shopify variant
## Definition
A Shopify variant is the sellable item in a Shopify store, such as one size or one colour of a product. In this system, each synced variant becomes a Shopify-linked product in the shop's catalog. The connection [backfills](shopify-backfill.md) only active variants. Later price, title and stock changes on a variant reach the catalog through the [webhook](shop-webhook.md) or the [scheduled pull](shopify-scheduled-pull.md).

## Example
Variant `V1`'s price changes to `21.50` in Shopify. The webhook arrives twice, but the catalog product linked to `V1` changes only once.

## Known gaps
- The spec does not say that one variant always maps to exactly one catalog product, or which field holds the link.
- The spec does not say what happens to a variant that becomes inactive or is deleted in Shopify.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): B-05
- [conditional-absolute-write](conditional-absolute-write.md)
- [csv-product](csv-product.md)
- [shop-integration](shop-integration.md)
- [shopify-connection](shopify-connection.md)
- [shopify-inventory](shopify-inventory.md)
- [shopify-link](shopify-link.md)
<!-- used-by:end -->
