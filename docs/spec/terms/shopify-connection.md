---
id: shopify-connection
title: Shopify connection
kind: term
status: draft
aliases: [connected store, connects]
defined_for: J04-catalog-sync-to-search
rules_hash: 2af9f0dd792f
---
# Shopify connection
## Definition
A Shopify connection links a shop to a Shopify store, so the store's products flow into the shop's catalog. Only a user holding `integrations.manage` can connect a store. Connecting starts a [backfill](shopify-backfill.md) of the store's [active variants](shopify-variant.md). After that, a [webhook](shop-webhook.md) brings changes fast, and a [scheduled pull](shopify-scheduled-pull.md) is the safety net. Stock changes on linked products are pushed back to Shopify by the [`integrations-stock-push` consumer](integrations-stock-push-queue.md).

## Example
Shop `SH`'s owner holds `integrations.manage` and connects a store with 7 active variants. All 7 appear in the catalog and in public search. A later device sale on linked product `Ps` lowers Shopify inventory to match.

## Known gaps
- The spec does not list the connect route, or how to disconnect a store.
- The spec does not say how the Shopify credentials are stored.
- The spec does not say what happens to linked products when a shop is suspended, beyond pushes and pulls stopping.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): B-05
- [catalog-sync-stock-conflict-opened-event](catalog-sync-stock-conflict-opened-event.md)
- [csv-product](csv-product.md)
- [scheduled-pull](scheduled-pull.md)
- [shopify-link](shopify-link.md)
- [stock-conflict](stock-conflict.md)
- [stock-merge](stock-merge.md)
- [stock-three-way-merge](stock-three-way-merge.md)
<!-- used-by:end -->
