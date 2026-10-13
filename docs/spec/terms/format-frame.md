---
id: format-frame
title: formatFrame
kind: term
status: draft
aliases: []
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# formatFrame
## Definition
`formatFrame` is the backend function that turns one [realtime event](realtime-event.md) into the text of a [stream frame](stream-frame.md). It is the code behind the rule that a [payload](event-payload.md) must not add a field, a comment or a frame to the stream. It writes the payload as a single line of JSON on the [data line](sse-data-line.md). When that line is parsed, it gives back the exact payload that was published.

## Example
A domain calls [`publish("price:42", "price", { price: 3 })`](realtime-publish.md), and `formatFrame` writes:
```
id: <cursor>
data: {"price":3}
```
The topic, type and values are illustrative. If a payload string contains a newline, it is escaped inside the JSON, so it can't start a new stream line.

## Known gaps
- The spec does not say whether `formatFrame` also writes the `id:`, `event:` and `retry:` lines, or only the data line. The page links the cursor `id:` to `encodeCursor`, not to `formatFrame`.
- The spec does not say whether the event `type` given to `publish` goes on an `event:` line or inside the JSON on the data line.
- Not confirmed in the code: how `formatFrame` handles a payload that can't be turned into JSON.

## Used by
<!-- used-by:start -->
- [event-payload](event-payload.md)
- [realtime-event](realtime-event.md)
- [sse-data-line](sse-data-line.md)
- [stream-frame](stream-frame.md)
<!-- used-by:end -->
