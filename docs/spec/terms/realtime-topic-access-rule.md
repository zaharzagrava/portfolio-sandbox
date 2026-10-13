---
id: realtime-topic-access-rule
title: Topic access rule
kind: term
status: draft
aliases: [access rules]
defined_for: realtime-topic-stream
rules_hash: e856ad81ee7e
---
# Topic access rule
## Definition
A topic access rule decides which [viewers](viewer.md) may open the [stream](stream-connection.md) on one [realtime topic](realtime-topic.md). The [hub](realtime-hub.md) gives each topic its own rule and checks it when a connection opens. A connection is let in for all the topics it asks for, or else it is let in for none of them. A refused anonymous viewer gets `401`, and a refused authenticated viewer gets `403`. A `403` for a topic that is not yours looks exactly like the `403` for a topic that does not exist.

## Example
A signed-in viewer opens the stream with two topics: their own `user:{userId}` and another user's `user:{userId}` (illustrative). If the second topic's rule refuses them, the whole connection gets `403` and no events arrive, not even for their own topic. That `403` is the same one they would get if the second topic did not exist. Design intent (not stated in the spec): the matching `403` stops a client from learning whether someone else's topic exists.

## Known gaps
- The spec does not say what the rule for `user:{userId}` checks. S13 publishes there for "the owner", which suggests an owner-only check, but the spec never says so.
- The spec does not say how rules are declared or which other topics have rules. The S51 page is the only place that covers the topic registry.
- The spec does not say whether a rule is checked again after a connection is admitted. `revoke` is listed but is described only on the S51 page.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-16, R-17, R-28, B-01, B-08, B-09
- [connection-admission](connection-admission.md)
- [default-deny-topic](default-deny-topic.md)
- [realtime-hub](realtime-hub.md)
- [realtime-policy-unavailable](realtime-policy-unavailable.md)
- [realtime-revoke](realtime-revoke.md)
- [realtime-route](realtime-route.md)
- [realtime-topic](realtime-topic.md)
- [ref-counted-fan-out](ref-counted-fan-out.md)
- [stream-connection](stream-connection.md)
- [topic-registry-frozen](topic-registry-frozen.md)
- [topic-registry](topic-registry.md)
- [viewer](viewer.md)
<!-- used-by:end -->
