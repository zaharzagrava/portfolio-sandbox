---
id: device-feed
title: Device feed
kind: term
status: draft
aliases: [feed]
defined_for: J04-catalog-sync-to-search
rules_hash: 5e88be2895a4
---
# Device feed
## Definition
The device feed is the change feed that an offline till device pulls to learn about catalog changes it did not make itself. The device asks for changes after a cursor and sends the `X-Device-Id` header. The `offline-sync-feed` consumer builds the feed from catalog events that travel through the outbox. Like every consumer in this journey, it is idempotent and version-guarded, so a replay does not change what the feed shows.

## Example
Device `D2` pulled at cursor `C0`. Another device then sells units of `Ps`. `D2` pulls again with `C0` and `X-Device-Id`, and the feed now holds an entry for `Ps` with the new quantity.

## Known gaps
- The spec does not say which fields a feed entry holds besides the product and its quantity.
- The spec does not say how long old cursors stay valid, or how far back the feed reaches.
- The spec does not say whether a device sees entries for its own sales.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): B-13
- [device-sale](device-sale.md)
- [device-sync](device-sync.md)
- [offline-sync-feed-consumer](offline-sync-feed-consumer.md)
- [till](till.md)
- [x-device-id-header](x-device-id-header.md)
<!-- used-by:end -->
