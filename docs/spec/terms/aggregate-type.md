---
id: aggregate-type
title: Aggregate type
kind: term
status: draft
aliases: [aggregate types, registered aggregate type]
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# Aggregate type
## Definition
An [aggregate](aggregate-id.md) type is the kind of aggregate that an event belongs to. Every event names one. Only registered aggregate types can carry events, and each one gets its own [`<aggregateType>.events` topic](aggregate-type-events-topic.md). The [outbox relay](outbox-relay.md) uses the event's aggregate type to choose that topic, and the [aggregateId](aggregate-id.md) to choose the [message key](event-key.md). Design intent (not stated in the spec): with one topic per kind of aggregate, a consumer subscribes only to the kinds it cares about.

## Example
An order changes, and its domain appends an event with aggregate type `orders` (illustrative). The relay publishes that event to `orders.events`, keyed by the order's aggregateId. If `orders` were not registered, the call would throw [`UnregisteredAggregateTypeError`](unregistered-aggregate-type-error.md) instead (S53.R-06).

## Known gaps
- The spec does not say where or how aggregate types are registered, or who may add a new one.
- The spec does not say whether an aggregate type must follow a naming pattern. The lowercase dotted rule in S53.R-02 covers event types only.
- Not confirmed in the code: that `orders.events`, `payments.events` and `products.events` come from the aggregate types `orders`, `payments` and `products`.

## Used by
<!-- used-by:start -->
- [aggregate-id](aggregate-id.md)
- [aggregate-type-events-topic](aggregate-type-events-topic.md)
- [event-key](event-key.md)
- [outbox-relay](outbox-relay.md)
- [unregistered-aggregate-type-error](unregistered-aggregate-type-error.md)
<!-- used-by:end -->
