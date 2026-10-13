---
id: monotonic-version
title: Monotonic version
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 5c49799fa59c
---
# Monotonic version
## Definition
A monotonic version is a version number on an [aggregate](aggregate-id.md) that only goes up with each change, like an [aggregateVersion](aggregate-version.md). For aggregates that have one, the notification consumer remembers the highest version it has already notified for each aggregate and [notification family](notification-family.md). If a later event arrives with a lower version, the consumer drops it. This stops an [out-of-order event ↗](../sw-external-terms.md#out-of-order-delivery) from sending an outdated message. Design intent (not stated in the spec): the [event backbone](event-backbone.md) guarantees [at-least-once publication ↗](../sw-external-terms.md#at-least-once-delivery) but may deliver late or out of order.

## Example
Say the consumer has already notified version 7 of order `ord_123` (illustrative values). An `order.fulfilment_changed` event for the same order then arrives with version 5. It is dropped, and the buyer gets no message about the older state.

## Known gaps
- The spec does not say which aggregates have a monotonic version. It also does not say what happens with an event whose version equals the highest one (the rule only drops versions that are lower).
- The spec does not say where the highest notified version is stored. It also does not say whether a dropped event is recorded as a [`stale` consumer outcome](consumer-outcomes.md).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-05
- [aggregate-id](aggregate-id.md)
- [aggregate-version](aggregate-version.md)
- [auctions-source-family](auctions-source-family.md)
- [consumer-outcomes](consumer-outcomes.md)
- [event-backbone](event-backbone.md)
- [notification-family](notification-family.md)
<!-- used-by:end -->
