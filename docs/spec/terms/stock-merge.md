---
id: stock-merge
title: Stock merge
kind: term
status: draft
aliases: [merge]
defined_for: J04-catalog-sync-to-search
rules_hash: 93f783ff5b63
---
# Stock merge
## Definition
The stock merge decides the new quantity when both the catalog and [Shopify](shopify-connection.md) changed stock since the [last sync](stock-sync-trigger.md). The result is `local + remote − base`. "Base" is the quantity both sides last agreed on. Sales made on either side are therefore all counted. If the result would be negative, both sides are set to 0 and one [`catalog_sync.stock_conflict_opened`](catalog-sync-stock-conflict-opened-event.md) event is raised, so a human decides instead of the system picking a side.

## Example
Base 10 on both sides. A device sells 2 (local 8) and Shopify sells 3 (remote 7) before the [stock push](stock-push.md). The [conditional write](conditional-absolute-write.md) "set 8, expected 10" is refused. The merge gives `8 + 7 − 10 = 5`.

## Known gaps
- The spec does not say where the base quantity is stored, or when it is updated.
- The spec does not say whether the merged value is written back with another conditional write, or what happens if that write is refused too.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
