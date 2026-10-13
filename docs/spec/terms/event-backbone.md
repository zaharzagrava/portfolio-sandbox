---
id: event-backbone
title: Event backbone
kind: term
status: draft
aliases: [shared event backbone]
defined_for: outbox-task-queue
rules_hash: 99d6b0b88454
---
# Event backbone
## Definition
The event backbone is the shared path that domains use to send events to each other. A domain records each event as a row in the same transaction as its state change, so if that transaction is undone, no event is sent. The [outbox relay](outbox-relay.md) then publishes the row to [Kafka ↗](../sw-external-terms.md#kafka-message) with [at-least-once publication](at-least-once-delivery.md). Consumers apply each event once in effect, so no event is lost. S53 owns the backbone, and domains react to each other without sharing a table.

## Example
S05 commits a product price change and appends one versioned product event in the same transaction (S05.R-20). The relay publishes the event to Kafka, keyed by the product's [aggregateId](aggregate-id.md). S32 reads catalog events like this one to update its search index.

## Known gaps
- The spec does not say what the "task queue" part of the backbone is. The concept title mentions tasks, but only event rules are given.
- The spec does not say whether S32 uses the outbox rules directly. Its line cites projection-and-replay, so the link to the backbone is inferred.
- The spec does not say how S01, S02 and S03 use the backbone, though they list it.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-04
- [projection-and-replay](../concepts/projection-and-replay.md): C-02
- [aggregate-id](aggregate-id.md)
- [at-least-once-delivery](at-least-once-delivery.md)
- [consumer-batch](consumer-batch.md)
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [heavy-hitters](heavy-hitters.md)
- [order-paid-event](order-paid-event.md)
- [outbox-append](outbox-append.md)
- [outbox-relay](outbox-relay.md)
- [outbox-rollback](outbox-rollback.md)
- [payments-events-topic](payments-events-topic.md)
- [products-events-topic](products-events-topic.md)
- [read-model](read-model.md)
- [read-your-writes](read-your-writes.md)
- [write-model](write-model.md)
<!-- used-by:end -->
