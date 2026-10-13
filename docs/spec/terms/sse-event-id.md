---
id: sse-event-id
title: id: line (event id)
kind: term
status: draft
aliases: [id:]
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# id: line (event id)
## Definition
The `id:` line of a [stream frame](stream-frame.md) carries the [replay cursor](replay-cursor.md), built by [`encodeCursor`](encode-cursor.md). The cursor holds positions for every topic the connection has seen so far, not only the topic of this event. The browser sends the latest value back as [`Last-Event-ID` ↗](../sw-external-terms.md#last-event-id) when it reconnects, and the [hub](realtime-hub.md) uses it for event replay. Events published with `replay: false` have no `id:` line, so they never move the cursor.

Design intent (not stated in the spec): putting every topic in one id means a single `Last-Event-ID` header can resume all topics of a connection at once.

## Example
A signed-in user subscribes to two topics, and one event is published to each. The second frame's `id:` names both topics:
```
id: <cursor covering both topics>
data: {...}
```

## Known gaps
- The spec does not describe the cursor format. Treat it as opaque.
- The spec does not say what the hub does with a `Last-Event-ID` entry for a topic the reconnect no longer requests. It only says that unusable entries are ignored, and that a header over the length limit is ignored completely.

## Used by
<!-- used-by:start -->
- [encode-cursor](encode-cursor.md)
- [realtime-hub](realtime-hub.md)
- [replay-cursor](replay-cursor.md)
- [replay-false](replay-false.md)
- [stream-frame](stream-frame.md)
<!-- used-by:end -->
