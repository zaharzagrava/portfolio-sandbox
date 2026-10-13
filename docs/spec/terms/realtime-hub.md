---
id: realtime-hub
title: Realtime hub
kind: term
status: draft
aliases: [hub]
defined_for: realtime-topic-stream
rules_hash: 9b7317720de4
---
# Realtime hub
## Definition
The realtime hub is the server-side component, defined by S51, that sends topic events to browsers over a long-lived connection. Before it accepts a connection, it checks the rule that says who may follow each topic. It replays missed events starting from the last point the browser saw, and it tells the browser to reload its state when it cannot prove that nothing was lost. On each instance, it opens one subscription per topic to the shared channel that carries events between instances, and all viewers of that topic share it.

## Example
S13 publishes `payment.status` to the owner's topic. The hub fans that event out to every open stream of that user that includes `user:{userId}`. W03 shows the payment result from that stream. If 50 tabs (illustrative) watch the same topic on one instance, the hub still holds only one backplane subscription for it.

## Known gaps
- The spec does not say which technology serves as the backplane.
- Only the S51 page describes the `revoke` API, the stall limit and the topic registry. The spec does not say whether any other capability uses them.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-10, R-11, R-26, B-14
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-05
- [best-effort-push](best-effort-push.md)
- [connection-admission](connection-admission.md)
- [create-event-stream](create-event-stream.md)
- [default-deny-topic](default-deny-topic.md)
- [encode-cursor](encode-cursor.md)
- [event-payload](event-payload.md)
- [invalid-topics](invalid-topics.md)
- [realtime-backplane](realtime-backplane.md)
- [realtime-config](realtime-config.md)
- [realtime-instance-limit](realtime-instance-limit.md)
- [realtime-listener](realtime-listener.md)
- [realtime-revoke](realtime-revoke.md)
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
- [realtime-topic](realtime-topic.md)
- [realtime-unavailable](realtime-unavailable.md)
- [ref-counted-fan-out](ref-counted-fan-out.md)
- [replay-buffer](replay-buffer.md)
- [replay-cursor](replay-cursor.md)
- [replay-false](replay-false.md)
- [replay-page](replay-page.md)
- [replayable-event](replayable-event.md)
- [resync-frame](resync-frame.md)
- [slow-consumer-close](slow-consumer-close.md)
- [sse-event-id](sse-event-id.md)
- [sse-event-type-line](sse-event-type-line.md)
- [stream-connection](stream-connection.md)
- [stream-frame](stream-frame.md)
- [unusable-cursor-entry](unusable-cursor-entry.md)
- [user-connection-cap](user-connection-cap.md)
<!-- used-by:end -->
