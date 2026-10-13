---
id: correction-path
title: Correction path
kind: term
status: draft
aliases: [correction]
defined_for: S35-trending
rules_hash: c188b2eaa058
---
# Correction path
## Definition
The correction path is how the [trending consumer](event-consumer.md) applies a late event to a [window](trending-window.md) that has already closed and merged. The event is still inside the [late-event horizon](late-event-horizon.md), and it is applied to the [aggregate](trending-aggregate.md) exactly once. Without this path, an event that arrived after its minute closed would be lost. The Decisions say late events take this route instead of being dropped silently.

## Example
Illustrative: the `11:20–11:21` window has already been merged. An `add_to_cart` for product `A` with event time `11:20:40` then arrives. The correction path adds 5 to `A` for that minute's aggregate once. Replaying the same `[event_id](event-id.md)` does not add it again.

## Known gaps
- The spec does not say how the correction path is implemented. For example, it does not say whether it rewrites the closed window's Redis key or keeps a separate correction entry.
- The spec does not say how "applied once" is guaranteed for corrections, such as deduplication by `event_id` or a separate [idempotency key](idempotency-key.md) like the merge's (partition, window, offsets).
- Not confirmed in the code: no code reference is given for the correction path. Only S35 AS-19 is cited as proof.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-17
- [allowed-lateness](allowed-lateness.md)
- [dropped-late-event](dropped-late-event.md)
- [event-consumer](event-consumer.md)
- [idempotency-key](idempotency-key.md)
- [late-event-horizon](late-event-horizon.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-minute-window](trending-minute-window.md)
- [trending-window](trending-window.md)
<!-- used-by:end -->
