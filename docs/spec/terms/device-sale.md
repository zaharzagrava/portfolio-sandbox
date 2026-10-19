---
id: device-sale
title: Device sale
kind: term
status: draft
aliases: []
defined_for: J04-catalog-sync-to-search
rules_hash: 0bbc04491cf3
---
# Device sale
## Definition
A device sale is a sale recorded by a [till](till.md), an offline device in the store. The device pushes it as a [`delta`](stock-delta.md) with one [`opId`](op-id.md) per operation. The sale applies [exactly once ↗](../sw-external-terms.md#idempotency) per [`(shopId, opId)`](stock-operation-id.md); a [replay](stock-operation-replayed.md) returns the stored outcome with no second effect. [The catalog](catalog-stock.md) accepts the sale without waiting for Shopify, so a Shopify outage does not block the till. Other devices learn the new quantity from the [change feed](device-feed.md).

## Example
[Shopify-linked](shopify-link.md) product `Ps` is at quantity 10. A device sells 2 while Shopify answers `503`. The push answers at once with [`quantityAfter 8`](quantity-after.md), and the next [trigger](stock-sync-trigger.md) repairs Shopify (J04 B-16). Device `D2` then pulls with [cursor `C0`](replay-cursor.md) and [`X-Device-Id`](x-device-id-header.md) and sees `Ps` at the new quantity (J04 B-13).

## Known gaps
- The spec does not say the request body shape of a push beyond `delta` and `opId`.
- The spec does not say what a device sale returns when the delta exceeds available stock.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
