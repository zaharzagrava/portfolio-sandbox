---
id: source-topic
title: Source topic
kind: term
status: draft
aliases: [source topics]
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# Source topic
## Definition
The source topic is the [Kafka topic ↗](../sw-external-terms.md#kafka-topic) an event was first read from before it was [dead-lettered](dead-letter-topic.md). For domain events, this is the [`<aggregateType>.events`](aggregate-type-events-topic.md) topic of the event's [aggregate type](aggregate-id.md). When an [operator](operator) [redrives](dead-letter-redrive) dead letters, each one goes back to its source topic with its original [key](event-key). Because the key stays the same, the event lands in the same [partition ↗](../sw-external-terms.md#kafka-partition) as the other events of its aggregate. Keeping that per-aggregate order is design intent (not stated in the spec).

## Example
A `fixtures.item_changed` event read from `<aggregateType>.events` fails its schema and goes to `<consumer>.dlq` with [`SCHEMA_INVALID`](schema-invalid.md). Later an operator runs [`pnpm projections:redrive`](dead-letter-redrive.md), and the event returns to `<aggregateType>.events` with its original `aggregateId` key (S53.B-14).

## Known gaps
- The spec does not say where the source topic is recorded on a dead-letter message (in a header or in a field). It also does not say what redrive does if that record is missing.
- The spec does not say whether [task rows](task-row.md) that are consumed from a queue can be redriven to their source queue in the same way.

## Used by
<!-- used-by:start -->
- [aggregate-id](aggregate-id.md)
- [dead-letter-topic](dead-letter-topic.md)
- [task-row](task-row.md)
<!-- used-by:end -->
