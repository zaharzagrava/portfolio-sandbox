---
id: event-key
title: Event key (partitioning key)
kind: term
status: draft
aliases: [key]
defined_for: S53-events-projections
rules_hash: 0c98a2781522
---
# Event key (partitioning key)
## Definition
The event key is the [Kafka message key ↗](../sw-external-terms.md#kafka-message) that the [relay](outbox-relay.md) sets on every published event. It is always the event's [`aggregateId`](aggregate-id.md). Kafka keeps messages with the same key in the same order, so all events of one aggregate are consumed in the order they were written. The [poller](relay-poller-mode.md) and the [CDC connector](outbox-connector-configuration.md) must both use this key, and a [redrive](dead-letter-redrive.md) must keep it.

## Example
An event for order `ord_123` (illustrative ID) is published to `orders.events` with:
```
key: ord_123
headers: eventId, type, version, traceparent
```
If this event is later dead-lettered and redriven, it returns to `orders.events` with the key `ord_123`.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-14
- [aggregate-type](aggregate-type.md)
- [dead-letter-redrive](dead-letter-redrive.md)
- [outbox-connector-configuration](outbox-connector-configuration.md)
- [outbox-relay](outbox-relay.md)
- [relay-poller-mode](relay-poller-mode.md)
<!-- used-by:end -->
