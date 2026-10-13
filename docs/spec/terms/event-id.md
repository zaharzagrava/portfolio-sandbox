---
id: event-id
title: eventId
kind: term
status: draft
aliases: []
defined_for: outbox-task-queue
rules_hash: 7735daad6828
---
# eventId
## Definition
`eventId` is the unique identity of one event. [The relay](outbox-relay.md) sends it as a [Kafka header ↗](../sw-external-terms.md#kafka-headers) with every message. When the relay delivers the same event twice, both copies carry the same `eventId`, so a [consumer](event-consumer.md) can tell a duplicate from a new event. [Inbox-style consumers](inbox-table.md) can use it to apply each event only once. That use is inferred from the inbox rule; the spec does not state it.

## Example
The relay sends an event and then crashes before it marks the row as sent. On retry, Kafka gets a second copy with the same header (value illustrative):
```
eventId: 9b1e2c40-…
```
The consumer's inbox already has `9b1e2c40-…` recorded, so it skips the second copy.

## Known gaps
- The spec does not say the format of `eventId` or exactly when it is assigned. It is probably assigned at [`append`](outbox-append.md), but that is not confirmed.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-26
- [S33](../capabilities/S33-autocomplete.md): R-19
- [distinct-searchers](distinct-searchers.md)
- [event-consumer](event-consumer.md)
- [inbox-table](inbox-table.md)
- [outbox-relay](outbox-relay.md)
- [query-index-build](query-index-build.md)
- [query-log](query-log.md)
- [search-log](search-log.md)
- [suggestion-build](suggestion-build.md)
<!-- used-by:end -->
