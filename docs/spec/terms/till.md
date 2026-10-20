---
id: till
title: Till
kind: term
status: draft
aliases: []
defined_for: J04-catalog-sync-to-search
rules_hash: f3f73948b484
---
# Till
## Definition
A till is the point-of-sale device in a physical store that sells units of a shop's products. It is an offline device: it records sales locally and talks to the marketplace through device sync. It pushes each sale as a device sale and pulls the [device feed](device-feed.md) to learn other stock changes. Its sales reach the catalog only through the catalog's [exported commands](exported-command.md), like every other product change. The catalog accepts a till's sale without waiting for Shopify, so a Shopify outage does not block the till.

## Example
Shopify-linked product `Ps` has [catalog stock](catalog-stock.md) 10. A till sells 2 while Shopify answers `503`. The push returns at once with `[quantityAfter](quantity-after.md) 8`, and the next trigger repairs Shopify (J04 B-16). A second device `D2` pulls with cursor `C0` and `X-Device-Id` and sees `Ps` at the new quantity (J04 B-13).

## Known gaps
- The spec does not say how a till is registered to a shop or how it gets the value it sends in `X-Device-Id`.
- The spec does not say how a till queues or orders sales made while it cannot reach the marketplace.
- The spec does not say whether "till" and "device" are always the same thing, or whether other device kinds also push sales.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
