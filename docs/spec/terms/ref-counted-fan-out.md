---
id: ref-counted-fan-out
title: Ref-counted fan-out
kind: term
status: draft
aliases: [fan-out, ref-counted]
defined_for: realtime-topic-stream
rules_hash: 6981d634ebc0
---
# Ref-counted fan-out
## Definition
Ref-counted fan-out is how a [hub instance](realtime-hub.md) shares a single [backplane subscription](realtime-backplane.md) per [topic](realtime-topic.md) among all its viewers. The number of viewers doesn't change the number of subscriptions. The instance receives each event of a topic once from the backplane. It then copies that event to every [stream connection](stream-connection.md) on that instance that asked for the topic. "Ref-counted" means the instance keeps a count of the viewers that use each topic's subscription. Design intent (not stated in the spec): backplane load grows with the number of topics being watched, not with the number of open browsers.

## Example
On one instance, three browser tabs (illustrative) watch the `user:{userId}` topic for the W03 notification bell and payment result. S13 publishes one `payment.status` event to that topic. The instance gets the event once through its single subscription and writes it to all three streams.

## Known gaps
- The spec does not say when an instance drops a topic's backplane subscription, for example right after the last viewer on that instance disconnects.
- The spec does not say what happens to connected viewers when the backplane subscription of a topic fails or drops.
- The spec does not say whether the count is kept per topic only, or per topic and [access rule](realtime-topic-access-rule.md) together.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): B-10, B-11
- [realtime-backplane](realtime-backplane.md)
- [realtime-hub](realtime-hub.md)
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
- [realtime-topic](realtime-topic.md)
- [realtime-unavailable](realtime-unavailable.md)
- [stream-connection](stream-connection.md)
<!-- used-by:end -->
