---
id: stock-three-way-merge
title: Stock three-way merge
kind: term
status: draft
aliases: [base, merge]
defined_for: J04-catalog-sync-to-search
rules_hash: 47b9a45aee24
---
# Stock three-way merge
## Definition
The rule that combines stock when both the [catalog](catalog-stock.md) and [Shopify](shopify-connection.md) changed since they last agreed. The result is `local + remote − base`. `base` is the last agreed quantity, `local` is the catalog quantity and `remote` is the Shopify quantity. This keeps sales from both sides. If the result would be negative, both sides are [clamped to zero](clamping.md) and a [stock conflict](stock-conflict.md) is opened.

## Example
From J04 B-14: base 10, a device sells 2 (local 8) and Shopify sells 3 (remote 7). The merge gives `8 + 7 − 10 = 5`.

## Known gaps
- The spec does not say where `base` is stored or when it is updated.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-15
- [conditional-absolute-write](conditional-absolute-write.md)
- [shopify-inventory](shopify-inventory.md)
- [shopify-link](shopify-link.md)
- [shopify-push-pull](shopify-push-pull.md)
- [shopify-write](shopify-write.md)
<!-- used-by:end -->
