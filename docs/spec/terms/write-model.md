---
id: write-model
title: Write model
kind: term
status: draft
aliases: [write-model]
defined_for: S53-events-projections
rules_hash: ad4856a09192
---
# Write model
## Definition
The write model is the [authoritative state](source-of-truth.md) of an [aggregate](aggregate-id.md). It is the data that a domain updates in its transaction, together with the [outbox row](event-row.md). It is always current, while query-side copies of the data catch up from the [event log](event-backbone.md) later. The [read-your-writes helper](read-your-writes.md) answers from the write model as a fallback when those copies have not caught up within the allowed waiting time.

## Example
A projection has stopped at version 6, and a client requests `[minVersion](min-version.md)=7`. When the read wait timeout expires, the route loads the aggregate from the write model and answers `200` with:
```
[X-Read-Source](x-read-source-header.md): write-model
```

## Known gaps
- The spec does not say whether every read route has a write-model fallback. A route configured for ["pending"](pending-read-mode.md) answers `202` instead.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-16
- [aggregate-id](aggregate-id.md)
- [authoritative-balance](authoritative-balance.md)
- [event-backbone](event-backbone.md)
- [event-row](event-row.md)
- [pending-read-mode](pending-read-mode.md)
- [read-model](read-model.md)
- [read-wait-timeout](read-wait-timeout.md)
- [read-your-writes](read-your-writes.md)
- [source-of-truth](source-of-truth.md)
<!-- used-by:end -->
