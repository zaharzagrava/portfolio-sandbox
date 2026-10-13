---
id: replayable-event
title: Replayable event
kind: term
status: draft
aliases: [replayable]
defined_for: realtime-topic-stream
rules_hash: b193a03612b9
---
# Replayable event
## Definition
A replayable event is one the [hub](realtime-hub.md) keeps in its per-topic [replay buffer](replay-buffer.md). Each one carries an `id:` holding a [cursor](replay-cursor.md) of all the [topics](realtime-topic.md) the client has seen. A client that reconnects with that cursor ([Last-Event-ID ↗](../sw-external-terms.md#last-event-id)) gets every stored event after it, in order. Replay never changes stored state. If the hub cannot prove nothing was lost, it sends a [`resync` frame](resync-frame.md) instead of a partial replay.

## Example
A browser loses its connection during checkout and reconnects with its last `id:` value. The hub replays the missed `payment.status` events for `user:{userId}` in order. If the cursor is older than what the buffer still holds, the browser gets `resync` with `reason: "replay-gap"` instead.

## Known gaps
- The spec does not say which events are not replayable, or how a publisher marks an event as replayable.
- The spec does not say the format of the cursor inside `id:`.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-06, R-09, B-12, B-15, B-17
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-04
- [realtime-event](realtime-event.md)
- [realtime-hub](realtime-hub.md)
- [realtime-topic](realtime-topic.md)
- [replay-buffer](replay-buffer.md)
- [replay-cursor](replay-cursor.md)
- [resync-frame](resync-frame.md)
<!-- used-by:end -->
