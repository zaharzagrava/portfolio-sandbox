---
id: applied-state
title: Applied state
kind: term
status: draft
aliases: []
defined_for: J05-engagement-loop
rules_hash: 6e56451b71cb
---
# Applied state
## Definition
Applied state is what an [event consumer](event-consumer.md) has already written into its [read model](read-model.md) for one item, such as a product's feed entry. Every consumer compares an incoming event against this state and discards any event that is older. A late or [replayed](event-replay.md) event therefore cannot undo a newer change. This is why an archived product stays out of the feed and a deleted post stays gone. Design intent (not stated in the spec): [delivery is at least once ↗](../sw-external-terms.md#at-least-once-delivery) and events can arrive out of order, so consumers cannot trust arrival order.

## Example
The seller archives P, and the feed consumer applies it, so P is hidden from the feed. Later, the operator replays [`products.events`](products-events-topic.md), and an older event for P (from when it was ACTIVE) arrives. The consumer sees that the event is older than its applied state and discards it, so P stays hidden.

## Known gaps
- The spec does not say how "older" is decided, for example by aggregate version or by event timestamp.
- The spec does not say whether a discarded event is counted or reported, for example as a stale consumer outcome.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
