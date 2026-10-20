---
id: stock-conflict
title: Stock conflict
kind: term
status: draft
aliases: []
defined_for: J04-catalog-sync-to-search
rules_hash: 5db553ea3304
---
# Stock conflict
## Definition
A record opened when the stock three-way merge gives an impossible negative quantity. Both the [catalog](catalog-stock.md) and [Shopify](shopify-connection.md) are set to zero. One [`catalog_sync.stock_conflict_opened` event](catalog-sync-stock-conflict-opened-event.md) is raised so a human can decide, instead of the system choosing a side. Each impossible merge opens exactly one conflict.

## Example
From J04 B-15: both sides hold 3. A [device](device-registration.md) sells 3 (local 0) and Shopify sells 2 (remote 1). The merge is `0 + 1 − 3 = −2`, so both sides are set to 0 and one conflict opens.

## Known gaps
- The spec does not say how a conflict is listed, resolved or closed, or who is notified.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-15
- [stock-three-way-merge](stock-three-way-merge.md)
<!-- used-by:end -->
