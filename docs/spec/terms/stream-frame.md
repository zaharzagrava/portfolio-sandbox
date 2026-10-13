---
id: stream-frame
title: Stream frame
kind: term
status: draft
aliases: [frames]
defined_for: realtime-topic-stream
rules_hash: 2c47e70e9d6d
---
# Stream frame
## Definition
A stream frame is one [server-sent-events ↗](../sw-external-terms.md#server-sent-events) message on the stream, such as one delivered event. A frame can carry an `id:` line that holds the [replay cursor](replay-cursor.md). [The hub](realtime-hub.md) also sends its own control frames, such as one that tells the client to reload its state when the hub cannot prove that no event was lost. The data inside an event must never be able to create a frame of its own.

## Example
A `resync` frame tells the client to reload its state instead of trusting a partial [replay](event-replay.md). Its wire layout below is illustrative:
```
event: resync
data: {"reason":"replay-gap"}
```

## Known gaps
- The spec does not say the exact wire layout of a frame. It does not say whether `resync` is sent as the SSE event name or inside `data`.
- The spec does not say whether the hub sends keep-alive or comment frames.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-05, R-12, R-27, B-02, B-18, B-19
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-02
- [connection-admission](connection-admission.md)
- [create-event-stream](create-event-stream.md)
- [encode-cursor](encode-cursor.md)
- [event-payload](event-payload.md)
- [event-replay](event-replay.md)
- [format-frame](format-frame.md)
- [realtime-hub](realtime-hub.md)
- [realtime-topic](realtime-topic.md)
- [replay-cursor](replay-cursor.md)
- [replay-false](replay-false.md)
- [resync-frame](resync-frame.md)
- [sse-data-line](sse-data-line.md)
- [sse-event-id](sse-event-id.md)
- [sse-event-type-line](sse-event-type-line.md)
- [stream-connection](stream-connection.md)
<!-- used-by:end -->
