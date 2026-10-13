---
id: consumer-batch
title: Consumer batch
kind: term
status: draft
aliases: [batch]
defined_for: projection-and-replay
rules_hash: 0c61f7204504
---
# Consumer batch
## Definition
A consumer batch is the group of events a consumer receives and processes together from the [event log](event-backbone.md). Each event in the batch is handled on its own: an event that fails its schema is [dead-lettered ↗](../sw-external-terms.md#dead-letter-queue) with [`SCHEMA_INVALID`](schema-invalid.md), and the rest still apply. [Offsets ↗](../sw-external-terms.md#kafka-offset-commit) for the batch are committed only after the [effects](consumer-effects.md). If the consumer disconnects before then, the events are [redelivered](at-least-once-delivery.md) rather than lost.

## Example
The search index consumer receives a batch of catalog events (count illustrative). It applies the valid ones, dead-letters one malformed event with `SCHEMA_INVALID`, and commits the offsets only after that.

## Known gaps
- The spec does not say how large a batch is or how the size is configured.
- The spec does not say whether the effects of a batch share one transaction or run one transaction per event.
- The spec does not say what happens to the batch when an event fails for a reason other than its schema, such as a database error.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-14, B-15
- [S53](../capabilities/S53-events-projections.md): B-09, B-12
- [projection-and-replay](../concepts/projection-and-replay.md): C-07
- [at-least-once-delivery](at-least-once-delivery.md)
- [consumer-effects](consumer-effects.md)
- [event-backbone](event-backbone.md)
- [schema-invalid](schema-invalid.md)
<!-- used-by:end -->
