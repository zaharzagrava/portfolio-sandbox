---
id: realtime-backplane
title: Realtime backplane
kind: term
status: draft
aliases: [backplane]
defined_for: realtime-topic-stream
rules_hash: 82862ba13949
---
# Realtime backplane
## Definition
The backplane is the shared layer that carries a [topic](realtime-topic.md)'s published events to every [hub instance](realtime-hub.md). Each instance holds only one backplane subscription per topic, however many [viewers](viewer.md) are watching that topic. The instance keeps a count of its viewers on each topic and passes every event on to each of its own connected viewers, which is the approach S51 describes. Design intent (not stated in the spec): the backplane load depends on how many topics are watched, not on how many browsers are connected.

## Example
On one instance, three browser tabs (illustrative) watch the same `user:{userId}` topic for the notification bell. S13 publishes one `payment.status` event. The instance receives it once through its single subscription and writes it to all three streams.

## Known gaps
- The spec does not say what technology the backplane uses, or whether it is the same thing as the [realtime store](realtime-store.md).
- The spec does not say when an instance drops a topic's subscription, for example right after the last viewer disconnects.
- The spec does not say what happens to connected viewers when the backplane subscription fails.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-21, B-10, B-17
- [realtime-hub](realtime-hub.md)
- [realtime-store](realtime-store.md)
- [realtime-topic](realtime-topic.md)
- [realtime-unavailable](realtime-unavailable.md)
- [ref-counted-fan-out](ref-counted-fan-out.md)
- [replay-buffer](replay-buffer.md)
- [viewer](viewer.md)
<!-- used-by:end -->
