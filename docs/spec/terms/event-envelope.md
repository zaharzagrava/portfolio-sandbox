---
id: event-envelope
title: Event envelope
kind: term
status: draft
aliases: [envelope, envelope json, serialized envelope]
defined_for: outbox-task-queue
rules_hash: 4892253b2b8a
---
# Event envelope
## Definition
The envelope is the serialized JSON form of one event as it is stored and published. [The relay](outbox-relay.md) publishes the envelope JSON to Kafka as the message, keyed by [`aggregateId`](aggregate-id.md). The message carries the headers [`eventId`](event-id.md), `type`, `version` and [`traceparent` ↗](../sw-external-terms.md#traceparent). The envelope's serialized size is checked against the limit in rule C-02.

## Example
```
key:     prod_123                         (illustrative aggregateId)
headers: eventId=7f3c9a…  type=ProductUpdated  version=2  traceparent=00-…-01   (illustrative)
value:   { …envelope JSON… }
```

## Known gaps
- The spec does not say which fields the envelope JSON itself contains. Only the key and the [Kafka headers ↗](../sw-external-terms.md#kafka-headers) are specified.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-13, R-17
- [S53](../capabilities/S53-events-projections.md): R-03
- [outbox-task-queue](../concepts/outbox-task-queue.md): C-02
- [search-index](../concepts/search-index.md): C-06
- [aggregate-type-events-topic](aggregate-type-events-topic.md)
- [event-row](event-row.md)
- [event-too-large-error](event-too-large-error.md)
- [outbox-relay](outbox-relay.md)
<!-- used-by:end -->
