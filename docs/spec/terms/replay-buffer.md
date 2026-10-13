---
id: replay-buffer
title: Replay buffer
kind: term
status: draft
aliases: [buffer]
defined_for: realtime-topic-stream
rules_hash: 93e0441344b0
---
# Replay buffer
## Definition
The replay buffer keeps the most recent events of each [topic](realtime-topic.md) so that a client that reconnects with a [cursor](replay-cursor.md) can get the events it missed, in order. The buffer has a limit on how many events it keeps and a limit on how old they can be, and older events are dropped. Reading from the buffer during replay never changes what is stored. Engineering inference: if a client's cursor is older than the oldest event the buffer still has, the [hub](realtime-hub.md) cannot prove that nothing was lost. So instead of a partial replay, it tells the client to discard its state and start fresh, giving `reason: "replay-gap"`.

## Example
A browser watching `user:{userId}` loses its connection for a few minutes. When it reconnects, it sends the `id:` cursor of the last event it received. The hub then sends every buffered `payment.status` event that came after that cursor. Under C-08, the buffer keeps between 1,000 and 1,200 events per topic, for at most one hour.

## Known gaps
- The spec does not say where the buffer lives. It could be in each instance's process or in the shared [backplane](realtime-backplane.md) store, and this decides whether replay works when the client reconnects to a different instance.
- The spec does not say which events count as "replayable", or whether events that are not replayable are left out of the buffer.
- Not confirmed in the code: a cursor that falls outside the buffer always produces the `replay-gap` resync. That link is an inference from C-05.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-08, R-13, B-05, B-12, B-15
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-08
- [baseline-frame](baseline-frame.md)
- [realtime-backplane](realtime-backplane.md)
- [realtime-config](realtime-config.md)
- [realtime-event](realtime-event.md)
- [realtime-hub](realtime-hub.md)
- [realtime-publish-limit](realtime-publish-limit.md)
- [realtime-store](realtime-store.md)
- [realtime-topic](realtime-topic.md)
- [replay-cursor](replay-cursor.md)
- [replay-false](replay-false.md)
- [replay-page](replay-page.md)
- [replayable-event](replayable-event.md)
- [resync-frame](resync-frame.md)
<!-- used-by:end -->
