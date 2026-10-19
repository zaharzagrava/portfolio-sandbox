---
id: shopify-import
title: Shopify import
kind: term
status: draft
aliases: [imports]
defined_for: J04-catalog-sync-to-search
rules_hash: cd69aaa59b3a
---
# Shopify import
## Definition
A Shopify import brings a Shopify store's products into a shop's catalog. It happens when a user with [`integrations.manage`](permission.md) connects the store: the store's [active](shop-status.md) variants are [backfilled](shopify-backfill.md) into the catalog and then appear in [public search](search-visibility.md). Like every product change, the backfill reaches the catalog only through its [exported commands](exported-command.md). When the shop is not active, imports must stop.

## Example
Shop `SH` connects a Shopify store with 7 active variants. The owner holds `integrations.manage`. After the backfill, all 7 variants are in the catalog and in public search (J04.B-05).

## Known gaps
- The spec does not say whether "imports" in J04.R-19 means the Shopify backfill, the bulk file import, or both. The page uses the word mostly for bulk file imports.
- The spec does not say which route connects a store or starts the backfill. No route list is in the facts.
- The spec does not say what happens to a backfill that is already running when the shop is suspended.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
