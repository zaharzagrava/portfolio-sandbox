---
id: catalog-sync-stock-conflict-opened-event
title: catalog_sync.stock_conflict_opened event
kind: term
status: draft
aliases: [catalog_sync.stock_conflict_opened]
defined_for: J04-catalog-sync-to-search
rules_hash: e67ae7112a35
---
# catalog_sync.stock_conflict_opened event
## Definition
`catalog_sync.stock_conflict_opened` is the event raised when a stock merge would give a negative quantity. Both the catalog and [Shopify](shopify-connection.md) are set to 0 instead, and exactly one conflict is opened for a human to settle. The system does not choose a winning side.

## Example
Stock is 3 on both sides. A device sells 3 and Shopify sells 2. The merge would give `0 + 1 − 3 = −2`, which is impossible. Both sides are set to 0 and one `catalog_sync.stock_conflict_opened` is raised.

## Known gaps
- The spec does not say which [topic ↗](../sw-external-terms.md#kafka-topic) carries the event, which [consumers](event-consumer.md) read it, or what its [payload](event-payload.md) holds.
- The spec does not say how a human sees the conflict, resolves it, or closes it.
- The spec does not say whether a second impossible merge on the same product opens a new conflict or reuses the open one.

## Used by
<!-- used-by:start -->
- [stock-conflict](stock-conflict.md)
<!-- used-by:end -->
