---
id: pickup-availability-consumer
title: Pickup-availability consumer
kind: term
status: draft
aliases: [pickup availability consumer]
defined_for: J04-catalog-sync-to-search
rules_hash: b68de49cf560
---
# Pickup-availability consumer
## Definition
The pickup-availability consumer is the [event consumer](event-consumer.md) that keeps the near-me index up to date. It reacts to [pickup stock](pickup-stock.md) changes and to catalog product changes, which reach it through the [outbox](inbox-table.md). It removes products that are not visible and products of shops that are not active. Another capability owns it; journey J04 only observes its results. Like every consumer in the chain, it is [idempotent ↗](../sw-external-terms.md#idempotency) and [version-guarded](version-guard.md), so a replay leaves the near-me index unchanged.

## Example
Product `Pc` has catalog quantity 5 and no pickup stock, so it is not "available near me". The seller stocks a pickup point, the consumer applies the change, and `Pc` appears near me (J04 B-08). When the admin suspends the shop, `Pc` leaves near-me (J04 B-20).

## Known gaps
- The spec does not say the consumer group name. The other consumers are named (`search-product-index`, `integrations-stock-push`, `offline-sync-feed`), but this one is only described in words.
- The spec does not say which capability owns this consumer, or the names of the pickup stock events it reads.
- The spec does not say how quickly the near-me index must follow a change. The numeric bounds are undefined in the facts.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
