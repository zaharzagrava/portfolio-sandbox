---
id: device-sync
title: Device sync
kind: term
status: draft
aliases: []
defined_for: J04-catalog-sync-to-search
rules_hash: 954e20ad3564
---
# Device sync
## Definition
Device sync is how an offline [till](till.md) in a store exchanges data with the marketplace.

- **Sending sales:** the device pushes sales as a [`delta`](stock-delta.md), with one [`opId`](op-id.md) per operation. Each sale applies exactly once per [`(shopId, opId)`](stock-operation-id.md). [A replay returns the stored outcome](stock-operation-replayed.md).
- **Receiving changes:** the device pulls a [change feed](device-feed.md) with a [cursor](replay-cursor.md) and the [`X-Device-Id` header](x-device-id-header.md). The feed is produced by the [`offline-sync-feed` consumer](offline-sync-feed-consumer.md).

Device sync belongs to one shop and is not reachable from another shop's routes.

## Example
Device `D2` pulled at cursor `C0` before a sale. It pulls again with `C0` and its `X-Device-Id`. The feed now holds an entry for `Ps` with the new quantity (J04.B-13).

If the device resends the same `opId`, the stored outcome returns with no second effect (J04.B-11).

## Known gaps
- The spec does not give the device sync routes or the shape of a feed entry.
- The spec does not say how long a stored `opId` outcome is kept for replay.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
