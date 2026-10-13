---
id: at-least-once-delivery
title: At-least-once publication
kind: term
status: draft
aliases: [at least once, publication]
defined_for: outbox-task-queue
rules_hash: cbc299157bf3
---
# At-least-once publication
## Definition
At-least-once publication means the [relay](outbox-relay.md) may publish an event more than once, but never loses it. If the relay crashes after sending a row but before marking it as sent, the row is sent again with the same [`eventId`](event-id.md). Consumers must therefore be [idempotent ↗](../sw-external-terms.md#idempotency). Each consumer declares [`inbox`](inbox-table.md), [`versionGuard`](version-guard.md) or [`natural`](natural-idempotency.md), and commits its Kafka offsets only after its effects are done.

## Example
A relay instance claims a row under its 30 s lease, sends the row to Kafka, and crashes before marking it. When the lease expires, another instance claims the row and sends it again with the same `eventId`. The consumer recognises the duplicate and does not apply it twice.

## Known gaps
- The spec does not say how each consumer strategy detects a duplicate. For example, it does not say what the inbox stores or how long it keeps it.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-08
- [S34](../capabilities/S34-recommendations.md): R-14
- [S53](../capabilities/S53-events-projections.md): R-11, R-20
- [outbox-task-queue](../concepts/outbox-task-queue.md): C-05, C-08
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-04
- [projection-and-replay](../concepts/projection-and-replay.md): C-06
- [best-effort-push](best-effort-push.md)
- [consumer-batch](consumer-batch.md)
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [event-backbone](event-backbone.md)
- [event-consumer](event-consumer.md)
- [inbox-table](inbox-table.md)
- [order-paid-event](order-paid-event.md)
- [outbox-relay](outbox-relay.md)
- [payment-processor](payment-processor.md)
<!-- used-by:end -->
