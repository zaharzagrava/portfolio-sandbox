---
id: shopify-link
title: Shopify link
kind: term
status: draft
aliases: [shopify-linked product]
defined_for: J04-catalog-sync-to-search
rules_hash: c9fc6258094f
---
# Shopify link
## Definition
A Shopify link ties a [catalog product](catalog-stock.md) to a [variant](shopify-variant.md) in a [connected Shopify store](shopify-connection.md). Links are created when a user holding [`integrations.manage`](permission.md) connects a store and its active variants are [backfilled](shopify-backfill.md). A stock change on a linked product is written to Shopify by [`integrations-stock-push`](integrations-stock-push-queue.md) as a [conditional absolute write](conditional-absolute-write.md). A product that is not linked never causes a Shopify call. [Shopify's echo](shopify-echo.md) of the marketplace's own write causes no catalog change, event or second write.

## Example
Linked catalog and Shopify stock are both 10. A device sells 2 and Shopify sells 3 before the push. The conditional write "set 8, expected 10" is refused, and [the merge gives 5](stock-three-way-merge.md) (J04 B-14).

## Known gaps
- The spec does not say how the link is stored on the product or variant.
- The spec does not say how a product is unlinked, or whether a [CSV product](csv-product.md) can later be linked.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-13
- [device-sale](device-sale.md)
- [shopify-write](shopify-write.md)
<!-- used-by:end -->
