---
id: offline-sync-feed-consumer
title: offline-sync-feed consumer
kind: term
status: draft
aliases: [offline-sync-feed]
defined_for: J04-catalog-sync-to-search
rules_hash: b9e3bf97225c
---
# offline-sync-feed consumer
## Definition
The `offline-sync-feed` consumer is the [event consumer](event-consumer.md) that builds the [device feed](device-feed.md) for device sync. It follows catalog product changes delivered through the [outbox](outbox-relay.md) and records them as feed entries. A [till](till.md) then pulls those entries with a [cursor](pagination-cursor.md) and its [`X-Device-Id` header](x-device-id-header.md). Like every consumer in the chain, it is [idempotent ↗](../sw-external-terms.md#idempotency) and [version-guarded](version-guard.md), so a replay or an old version leaves the feed unchanged. If it is [paused](consumer-pause.md), the other consumers keep running, and its [consumer lag](consumer-lag.md) returns to zero after resume.

## Example
Device `D2` pulls at cursor `C0`. Another device then sells units of the Shopify-linked product `Ps`. The consumer records the new quantity for `Ps`. When `D2` pulls again with `C0` and its `X-Device-Id`, the feed holds an entry for `Ps` with that quantity (J04.B-13).

## Known gaps
- The spec does not say which topic the consumer reads. It only says that events travel through the outbox and that only the catalog writes `catalog.product_*` events.
- The spec does not give the shape of a feed entry or the format of the cursor.
- The spec does not include a scenario that pauses this consumer. The pause and resume rule (J04.R-18) is proven only for `search-product-index` and `integrations-stock-push`.

## Used by
<!-- used-by:start -->
- [device-sync](device-sync.md)
<!-- used-by:end -->
