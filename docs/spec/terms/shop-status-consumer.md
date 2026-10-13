---
id: shop-status-consumer
title: ShopStatusConsumer
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# ShopStatusConsumer
## Definition
`ShopStatusConsumer` is the catalog's [event consumer](event-consumer.md) for [`tenancy.shop_status_changed`](shop-status-changed-event.md). It stores the catalog's own copy of each shop's status. The catalog uses that copy to decide whether a shop's products may be public. The consumer ignores an event if its [`shopVersion`](shop-version.md) is not higher than the stored one, so a [stale or duplicate event](consumer-outcomes.md) changes nothing. When it accepts an event, it deletes the shop's [product cache entries](cache-entry.md) in [bounded batches](bounded-batch.md), so readers stop seeing views that no longer apply.

## Example
A shop with 2,500 products is [suspended](shop-status.md) at `shopVersion: 5`. Once the consumer processes the event, every product in the shop answers the same `404` as an unknown ID. A later event at `shopVersion: 6` reinstates the shop, and its products become visible again. If an event with `shopVersion: 5` is delivered a second time after that, the consumer ignores it.

## Known gaps
- The spec does not say which table holds the catalog's copy of the shop status. [`ProductShopState`](product-shop-state.md) is a likely candidate, but nothing confirms it.
- The spec does not say which topic or [consumer group](consumer-group.md) the consumer reads `tenancy.shop_status_changed` from.
- The spec does not say whether this class also handles [`tenancy.shop_deleted`](shop-deleted-event.md). That consumer is listed separately, and only the file `shop-consumers.ts` is shared.

## Used by
<!-- used-by:start -->
- [bounded-batch](bounded-batch.md)
- [cache-entry](cache-entry.md)
- [consumer-group](consumer-group.md)
- [consumer-outcomes](consumer-outcomes.md)
- [event-consumer](event-consumer.md)
- [shop-status](shop-status.md)
<!-- used-by:end -->
