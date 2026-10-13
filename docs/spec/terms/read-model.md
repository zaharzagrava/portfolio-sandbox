---
id: read-model
title: Read model
kind: term
status: draft
aliases: [read-model]
defined_for: S53-events-projections
rules_hash: e87511822287
---
# Read model
## Definition
A read model is a query-optimised copy of data that a [projection consumer](event-consumer.md) builds from events. It is not the [source of truth](source-of-truth.md), and it can be rebuilt from the [event log](event-backbone.md) at any time. Because it is updated asynchronously, it can lag behind the [write model](write-model.md). The [read-your-writes helper](read-your-writes.md) checks the read model's checkpoint against [`minVersion`](min-version.md) to decide whether the read model is fresh enough to answer from.

## Example
A projection has applied events up to version 7 for an aggregate. A client calls the read route with `minVersion=7`. The route answers `200` from the read model:
```
X-Read-Source: read-model

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-15
- [event-backbone](event-backbone.md)
- [event-consumer](event-consumer.md)
- [event-sink](event-sink.md)
- [read-your-writes](read-your-writes.md)
- [source-of-truth](source-of-truth.md)
- [write-model](write-model.md)
<!-- used-by:end -->
