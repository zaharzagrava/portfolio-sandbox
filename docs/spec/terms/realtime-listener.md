---
id: realtime-listener
title: Listener (realtime)
kind: term
status: draft
aliases: [listeners]
defined_for: S51-realtime-push
rules_hash: 96c4057f64fa
---
# Listener (realtime)
## Definition
A listener is a handler that receives the events of one [topic](realtime-topic.md) on one [instance](worker-instance.md). A domain registers it through `subscribe(topic, handler)`, which shares the instance's [ref-counted backplane subscription](cache-broadcast-subscription.md) for that topic. Every listener on a topic gets each event. If one listener throws, [the hub](realtime-hub.md) keeps delivering to all the others.

## Example
A domain in the same process calls `subscribe("user:<A>", handler)` (topic value illustrative). Another listener on the same topic throws while it handles an event. `handler` still receives that event and the ones after it.

## Known gaps
- The spec does not say what happens to the error a failing listener throws (logged, counted or swallowed), or whether that listener stays subscribed.
- The spec does not say whether open [stream connections](stream-connection.md) count as listeners under this rule, or only in-process `subscribe` handlers.
- Not confirmed in the code: the page lists the rules for the in-process subscriber as unproven, because no tagged test covers them.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-23
- [cache-broadcast-subscription](cache-broadcast-subscription.md)
- [realtime-hub](realtime-hub.md)
- [realtime-topic](realtime-topic.md)
- [stream-connection](stream-connection.md)
- [worker-instance](worker-instance.md)
<!-- used-by:end -->
