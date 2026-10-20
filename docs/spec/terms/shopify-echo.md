---
id: shopify-echo
title: Shopify echo
kind: term
status: draft
aliases: []
defined_for: J04-catalog-sync-to-search
rules_hash: 0fa5b90fd9c3
---
# Shopify echo
## Definition
A Shopify change notice, from a [webhook](shop-webhook.md) or a [scheduled pull](scheduled-pull.md), that only reports back a write the marketplace made itself. [The sync](shopify-push-pull.md) recognises it as its own write and drops it. It causes no catalog change, no [`catalog.product_*` event](catalog-product-events.md) and no second write to Shopify. Without this, design intent (not stated in the spec), each [push](shopify-push-pull.md) could start an endless loop of updates.

## Example
`Ps` is at 10. A device sells 2 and the push writes 8 to Shopify. Shopify then sends a webhook saying the variant is at 8. The webhook is ignored and [`productVersion`](product-version.md) stays the same. (Quantities illustrative.)

## Known gaps
- The spec does not say how an echo is recognised, for example by comparing values or by remembering the last written quantity.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-14
- [shopify-inventory](shopify-inventory.md)
- [shopify-link](shopify-link.md)
- [shopify-write](shopify-write.md)
<!-- used-by:end -->
