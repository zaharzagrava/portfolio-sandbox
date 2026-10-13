---
id: event-replay
title: Event replay
kind: term
status: draft
aliases: [replay]
defined_for: outbox-task-queue
rules_hash: 6ae91652b128
---
# Event replay
## Definition
Replay is named in one part of the spec as something it defines, but the spec gives no rule for it. In general engineering, replay means reading past events again to rebuild or repair a [projection ↗](../sw-external-terms.md#projection). [Consumers](event-consumer.md) that in effect apply each event only once make reading events again safe, though this is design intent and the spec does not state it. Treat any detail beyond the name as unconfirmed.

## Example
Illustrative, not taken from the spec: [S32](../capabilities/S32-product-search.md)'s [search index](search-index.md) gets corrupted. Catalog events are read again from the start, and the index is rebuilt. Duplicate events are harmless because the consumer is [idempotent ↗](../sw-external-terms.md#idempotency).

## Known gaps
- The spec does not say how replay works: how it is triggered, where it starts, or whether it reads from Kafka or from the outbox table.
- The spec does not say how this term relates to projection-and-replay, which S32 cites.
- The spec does not say which consumers support replay.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): B-14
- [S35](../capabilities/S35-trending.md): R-20
- [S51](../capabilities/S51-realtime-push.md): R-07, B-04, B-15, B-18
- [projection-and-replay](../concepts/projection-and-replay.md): C-02
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-04, C-05
- [search-index](../concepts/search-index.md): C-08
- [basket](basket.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [event-consumer](event-consumer.md)
- [order-baskets-projector](order-baskets-projector.md)
- [order-paid-event](order-paid-event.md)
- [parked-row](parked-row.md)
- [published-row](published-row.md)
- [replay-cursor](replay-cursor.md)
- [search-index](search-index.md)
- [stream-frame](stream-frame.md)
- [verification-failed](verification-failed.md)
<!-- used-by:end -->
