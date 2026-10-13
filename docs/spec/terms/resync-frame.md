---
id: resync-frame
title: resync frame
kind: term
status: draft
aliases: [resync]
defined_for: realtime-topic-stream
rules_hash: 86ab2fbeea96
---
# resync frame
## Definition
A `resync` frame is a special [stream frame](stream-frame.md) with `reason: "replay-gap"`. The hub sends it when a client reconnects with a [replay cursor](replay-cursor.md) but [the hub](realtime-hub.md) cannot prove that no event was lost. The hub sends one `resync` frame instead of a partial replay, so the client never mistakes an incomplete history for a complete one. Design intent (not stated in the spec): the client should then reload the current state through normal reads, not rebuild it from the stream.

## Example
A browser comes back after a long time offline. Its cursor points before the oldest event still in the [replay buffer](replay-buffer.md) for `user:{userId}`. The hub sends one frame:
```
event: resync
data: {"reason":"replay-gap"}
```
(The exact framing is illustrative.)

## Known gaps
- The spec does not say whether `resync` can carry any reason other than `"replay-gap"`.
- The spec does not say whether the stream stays open and carries live events after a `resync`, or whether it closes.
- The spec does not give the exact wire format of the frame.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-11, B-05
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-05
- [realtime-hub](realtime-hub.md)
- [replay-buffer](replay-buffer.md)
- [replay-cursor](replay-cursor.md)
- [replayable-event](replayable-event.md)
- [stream-connection](stream-connection.md)
- [stream-frame](stream-frame.md)
- [unusable-cursor-entry](unusable-cursor-entry.md)
<!-- used-by:end -->
