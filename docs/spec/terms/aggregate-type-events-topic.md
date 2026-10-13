---
id: aggregate-type-events-topic
title: <aggregateType>.events topic
kind: term
status: draft
aliases: [<aggregatetype>.events]
defined_for: S53-events-projections
rules_hash: fd0e65cd15ff
---
# <aggregateType>.events topic
## Definition
The `<aggregateType>.events` topic is the [Kafka topic ↗](../sw-external-terms.md#kafka-topic) that holds the domain events of one registered kind of aggregate; each registered kind gets its own topic, and [S53](../capabilities/S53-events-projections.md) owns all of them. The [outbox relay](outbox-relay) publishes each [pending event row](pending-row.md) there as [unwrapped envelope JSON](event-envelope.md). Each message's key is its [`aggregateId`](aggregate-id.md), and its headers are `eventId`, `type`, `version` and [`traceparent` ↗](../sw-external-terms.md#traceparent). Because the key is the `aggregateId`, all events of one aggregate stay in their original order. An event for a kind of aggregate that is not registered throws [`UnregisteredAggregateTypeError`](unregistered-aggregate-type-error.md) and never reaches any topic.

## Example
A transaction moves aggregate A from version 3 to version 4 and appends `fixtures.item_changed` (S53.B-01). The relay then publishes one message to A's aggregate-type topic:
```
topic:   <aggregateType>.events      (for example orders.events)
key:     <aggregateId of A>
headers: eventId, type=fixtures.item_changed, version, traceparent
value:   the envelope JSON, unwrapped
```
The poller relay mode and the CDC relay mode publish exactly the same message (S53.R-09).

## Known gaps
- The spec does not say where aggregate types are registered, or who creates these topics, or how many partitions and how much retention each one gets.
- The spec does not say how a topic gets the `latest-per-key` policy. It only says that startup refuses such a topic with `TopicPolicyError` if any of its event definitions does not carry full aggregate state (S53.R-07).
- Not confirmed in the code: that the existing topic names `orders.events`, `payments.events` and `products.events` come from this pattern, rather than being named separately.

## Used by
<!-- used-by:start -->
- [aggregate-type](aggregate-type.md)
- [event-envelope](event-envelope.md)
- [pending-row](pending-row.md)
- [security-events](security-events.md)
- [unregistered-aggregate-type-error](unregistered-aggregate-type-error.md)
<!-- used-by:end -->
