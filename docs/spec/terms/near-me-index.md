---
id: near-me-index
title: Near-me index
kind: term
status: draft
aliases: []
defined_for: J04-catalog-sync-to-search
rules_hash: 02b796fb7735
---
# Near-me index
## Definition
The near-me index is the read side behind "available near me" search. It is maintained by the [pickup-availability consumer](pickup-availability-consumer.md), which is owned by another [capability](capability.md). It follows both [pickup stock](pickup-stock.md) changes and [catalog product changes](catalog-product-events.md). It shows only [visible products](is-publicly-visible.md) of active shops, so a [suspended](shop-status.md) shop leaves it.

## Example
Product `Pc` has catalog quantity 5 and no pickup stock, so it does not appear near me. The seller stocks a pickup point, and `Pc` appears in "available near me" (J04 B-08). A later catalog change to `Pc` is reflected there too (J04 B-09).

## Known gaps
- The spec does not say the exact consumer group name of the pickup-availability consumer.
- The spec does not say how distance or location is matched in a near-me search.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-10
<!-- used-by:end -->
