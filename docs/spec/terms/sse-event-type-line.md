---
id: sse-event-type-line
title: event: line (event type)
kind: term
status: draft
aliases: [event:]
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# event: line (event type)
## Definition
The `event:` line is the optional line in a [stream frame](stream-frame.md) that names the event's type. The browser uses it to send the frame to the listener registered for that name. In this [hub](realtime-hub.md), every [`publish`](realtime-publish.md) call passes a `type`, and the hub also sends its own frames, such as [`resync`](resync-frame.md) and [`revoked`](realtime-revoke.md). The spec does not say whether these types are written on an `event:` line.

## Example
This assumes the type is written on an `event:` line, which is not confirmed:
```
id: <cursor>
event: resync
data: {"reason":"replay-gap"}
```
In the web client, the [`createEventStream`](create-event-stream.md) wrapper would then listen with [`addEventListener("resync", …)` ↗](../sw-external-terms.md#server-sent-events). The frame layout is illustrative.

## Known gaps
- The spec does not say whether the event type is sent on an `event:` line or inside the JSON on the [data line](sse-data-line.md).
- The spec does not say how the [`baseline`](baseline-frame.md), `resync` and `revoked` frames are told apart from domain events on the wire.
- Not confirmed in the code: whether [`formatFrame`](format-frame.md) checks a `type` value, for example rejecting a newline, before writing it into a frame.

## Used by
<!-- used-by:start -->
- [realtime-hub](realtime-hub.md)
- [sse-data-line](sse-data-line.md)
- [stream-frame](stream-frame.md)
<!-- used-by:end -->
