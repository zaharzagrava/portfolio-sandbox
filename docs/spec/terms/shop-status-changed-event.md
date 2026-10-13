---
id: shop-status-changed-event
title: tenancy.shop_status_changed event
kind: term
status: draft
aliases: [tenancy.shop_status_changed]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# tenancy.shop_status_changed event
## Definition
`tenancy.shop_status_changed` is an event published by the [tenancy domain](tenancy-domain-layer.md) when a shop's status changes. The catalog consumes it with [`ShopStatusConsumer`](shop-status-consumer.md) and keeps its own copy of the shop status. The catalog uses that copy to decide whether the shop's products are public. If the event's [`shopVersion`](shop-version.md) is not above the stored one, the catalog ignores it. For an accepted event, the catalog drops the shop's [cache entries](cache-entry.md) in [bounded batches](bounded-batch.md), so readers stop getting stale public views.

## Example
A shop with 2,500 products is [suspended](shop-status.md) at `shopVersion: 5`. After the event is consumed, its products answer `404`. A later event with `shopVersion: 6` reinstates the shop, and its products are visible again.

## Known gaps
- The spec does not say which table holds the catalog's copy of the status. [`ProductShopState`](product-shop-state.md) is a likely candidate, but this is not confirmed.
- The spec does not say which topic the event is published on.

## Used by
<!-- used-by:start -->
- [bounded-batch](bounded-batch.md)
- [cache-entry](cache-entry.md)
- [shop-status](shop-status.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
