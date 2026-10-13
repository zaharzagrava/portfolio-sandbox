---
id: schema-invalid
title: SCHEMA_INVALID
kind: term
status: draft
aliases: []
defined_for: projection-and-replay
rules_hash: e3b0c44298fc
---
# SCHEMA_INVALID
## Definition
`SCHEMA_INVALID` is the reason recorded when a [consumer](event-consumer.md) [dead-letters ↗](../sw-external-terms.md#dead-letter-queue) an event because its payload fails the schema for its type. Only that event is dead-lettered. The other events in the same [consumer batch](consumer-batch.md) still apply. Design intent (not stated in the spec): this way, one malformed event cannot block a [projection ↗](../sw-external-terms.md#projection).

## Example
A batch holds three `order.paid` events. The second one has a payload that does not match the `order.paid` schema. That event is dead-lettered with `SCHEMA_INVALID`, and `OrderBasketsProjector` still records baskets for the other two.

## Known gaps
- The spec does not say where dead-lettered events are stored or how to inspect and reprocess them.
- The spec does not say whether the [offset of a `SCHEMA_INVALID` event is committed ↗](../sw-external-terms.md#kafka-offset-commit).

## Used by
<!-- used-by:start -->
- [consumer-batch](consumer-batch.md)
- [event-consumer](event-consumer.md)
- [known-unmapped-type](known-unmapped-type.md)
<!-- used-by:end -->
