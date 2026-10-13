---
id: event-definition
title: Typed event definition
kind: term
status: draft
aliases: [event definition, typed definition]
defined_for: outbox-task-queue
rules_hash: 4daa177f28cc
---
# Typed event definition
## Definition
A typed event definition declares one kind of event and the schema its payload must match. Every event must be created from such a definition. An event whose payload fails the schema is not accepted. This event contract belongs to the shared part of the system that holds outgoing events and queued background work, so all domains publish events in the same checked shape.

## Example
[S05](../capabilities/S05-products.md) builds its product event from a definition (name `ProductUpdated` is illustrative). The payload is checked against that definition's schema before [`append`](outbox-append.md) writes it to the [outbox](inbox-table.md).

## Known gaps
- The spec does not say which schema language is used or what error a schema failure raises.
- The spec does not say whether the definition supplies the `type` and `version` that appear as [Kafka headers ↗](../sw-external-terms.md#kafka-headers), or how versions change over time.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-01
- [outbox-task-queue](../concepts/outbox-task-queue.md): C-02
- [projection-and-replay](../concepts/projection-and-replay.md)
- [search-index](../concepts/search-index.md): C-01, C-02
- [carries-state](carries-state.md)
- [catalog-product-events](catalog-product-events.md)
- [inbox-table](inbox-table.md)
- [latest-per-key-topic](latest-per-key-topic.md)
- [order-paid-event](order-paid-event.md)
- [payment-status-event](payment-status-event.md)
- [product-version](product-version.md)
- [search-surface](search-surface.md)
- [shop-status](shop-status.md)
- [topic-policy-error](topic-policy-error.md)
<!-- used-by:end -->
