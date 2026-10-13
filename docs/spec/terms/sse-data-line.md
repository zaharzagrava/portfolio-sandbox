---
id: sse-data-line
title: data line (stream frame)
kind: term
status: draft
aliases: [data line]
defined_for: S51-realtime-push
rules_hash: 8a7d6a4b8fd7
---
# data line (stream frame)
## Definition
The `data` line is the part of a [stream frame](stream-frame.md) that carries the [event payload](event-payload.md). [`formatFrame`](format-frame.md) writes it as one line of JSON, and that line parses back to exactly the payload that was [published](realtime-publish.md). Because it is always a single JSON line, a payload cannot add a field, a comment or a whole new frame to the stream.

## Example
```
id: <cursor>
data: {"price":3}
```
(The values are illustrative. A payload string that contains a newline is escaped inside the JSON, so it cannot start a new line.)

## Known gaps
- The spec does not say whether the [event type](realtime-event.md) is sent on an [`event:` line](sse-event-type-line.md) or inside the JSON in the `data` line.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-05
- [event-payload](event-payload.md)
- [format-frame](format-frame.md)
- [realtime-event](realtime-event.md)
- [realtime-publish](realtime-publish.md)
- [sse-event-type-line](sse-event-type-line.md)
- [stream-frame](stream-frame.md)
<!-- used-by:end -->
