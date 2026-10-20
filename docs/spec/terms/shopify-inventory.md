---
id: shopify-inventory
title: Shopify inventory
kind: term
status: draft
aliases: [inventory]
defined_for: J04-catalog-sync-to-search
rules_hash: 02bff83a1ccd
---
# Shopify inventory
## Definition
Shopify inventory is the stock quantity that the seller's connected Shopify store holds for a [linked variant](shopify-variant.md). The marketplace lowers it to match [catalog stock](catalog-stock.md) after a sale, using a [conditional absolute write](conditional-absolute-write.md). Shopify can also sell units on its own side. When both sides changed, [the merge is `local + remote − base`](stock-three-way-merge.md). When the marketplace's own write comes back from Shopify as an [echo](shopify-echo.md), it changes nothing in the catalog.

## Example
Catalog stock and Shopify inventory are both 10. A device sells 2 and Shopify sells 3 before the push happens. The write "set 8, expected 10" is refused, and the merge gives 5 on both sides.

## Known gaps
- The spec does not say how a conflict opened by an impossible merge is resolved, beyond that it goes to a human.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): B-10
<!-- used-by:end -->
