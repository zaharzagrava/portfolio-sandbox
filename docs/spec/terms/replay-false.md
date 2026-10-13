---
id: replay-false
title: replay: false
kind: term
status: draft
aliases: [replay false]
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# replay: false
## Definition
`replay: false` marks a published event as not replayable. [The hub](realtime-hub.md) sends it to the clients connected at that moment, and its [stream frame](stream-frame.md) carries no [`id:` line](sse-event-id.md). Because there is no `id:`, the frame does not move the client's [replay cursor](replay-cursor.md). A reconnecting client therefore cannot resume from that event. Use it for short-lived signals that are useless after the moment has passed. That reason is design intent (not stated in the spec).

## Example
A domain publishes a transient signal (topic, type and payload are illustrative):
```ts
publish('user:<A>', 'typing', { on: true }, { replay: false })
```
The client receives a frame with a `data:` line and no `id:` line. A replayable event on the same topic would carry `id:` with the cursor.

## Known gaps
- The spec does not say whether `replay` is a field of the `options` argument of `publish`, or what its default is.
- The spec does not say whether a `replay: false` event is kept out of the [replay buffer](replay-buffer.md), or what `id` value `publish` returns for it.
- The spec does not say how a `replay: false` event is ordered against the cursor rule for live messages (S51.R-12), since it has no position in the cursor.

## Used by
<!-- used-by:start -->
- [realtime-hub](realtime-hub.md)
- [replay-buffer](replay-buffer.md)
- [replay-cursor](replay-cursor.md)
- [sse-event-id](sse-event-id.md)
- [stream-frame](stream-frame.md)
<!-- used-by:end -->
