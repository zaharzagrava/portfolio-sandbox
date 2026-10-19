---
id: event-backbone
title: Event backbone
kind: term
status: draft
aliases: [shared event backbone]
defined_for: outbox-task-queue
rules_hash: 098561181533
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
- [S28](../capabilities/S28-notifications.md): R-51
- [S32](../capabilities/S32-product-search.md): R-43
- [S53](../capabilities/S53-events-projections.md): B-04
- [projection-and-replay](../concepts/projection-and-replay.md): C-02
- [aggregate-id](aggregate-id.md)
- [at-least-once-delivery](at-least-once-delivery.md)
- [auctions-source-family](auctions-source-family.md)
- [billing-events-topic](billing-events-topic.md)
- [consumer-batch](consumer-batch.md)
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [heavy-hitters](heavy-hitters.md)
- [ledger-events-topic](ledger-events-topic.md)
- [monotonic-version](monotonic-version.md)
- [order-paid-event](order-paid-event.md)
- [outbox-append](outbox-append.md)
- [outbox-relay](outbox-relay.md)
- [outbox-rollback](outbox-rollback.md)
- [payments-events-topic](payments-events-topic.md)
- [payout-failed-event](payout-failed-event.md)
- [payout-paid-event](payout-paid-event.md)
- [products-events-topic](products-events-topic.md)
- [raw-token](raw-token.md)
- [read-model](read-model.md)
- [read-your-writes](read-your-writes.md)
- [search-events-dropped-total](search-events-dropped-total.md)
- [write-model](write-model.md)
<!-- used-by:end -->
