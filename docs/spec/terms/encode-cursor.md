---
id: encode-cursor
title: encodeCursor
kind: term
status: draft
aliases: []
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# encodeCursor
## Definition
`encodeCursor` is the function that builds the [replay cursor](replay-cursor.md) written on the [`id:` line](sse-event-id.md) of a [stream frame](stream-frame.md). The cursor covers every topic the connection has seen so far, not only the topic of the current event. When the browser reconnects, it sends the latest cursor back as [`Last-Event-ID` ↗](../sw-external-terms.md#last-event-id), and the [hub](realtime-hub.md) uses it to run event replay. A `replay: false` event gets no `id:` line, so the browser's last received id stays the same.

Design intent (not stated in the spec): one id that covers all topics lets a single `Last-Event-ID` header resume every topic of a connection at once.

## Example
A signed-in user subscribes to two topics, and one event is published to each. The second frame's `id:` names both topics (the value below is a placeholder, not the real format):
```
id: <cursor covering both topics>
data: {...}
```

## Known gaps
- The spec does not describe the cursor format. Treat the value as opaque and never parse or build it in client code.
- The spec does not say what the hub does with a `Last-Event-ID` entry for a topic the reconnect no longer requests. It only says the hub ignores unusable entries, and ignores the whole header when it is longer than the length limit.

## Used by
<!-- used-by:start -->
- [realtime-hub](realtime-hub.md)
- [replay-cursor](replay-cursor.md)
- [sse-event-id](sse-event-id.md)
- [stream-frame](stream-frame.md)
<!-- used-by:end -->
