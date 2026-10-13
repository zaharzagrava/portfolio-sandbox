---
id: replay-cursor
title: Replay cursor
kind: term
status: draft
aliases: [cursor]
defined_for: realtime-topic-stream
rules_hash: 52f6d4b23f59
---
# Replay cursor
## Definition
The replay cursor is the position marker that the [realtime hub](realtime-hub.md) writes into the [`id:` field ↗](../sw-external-terms.md#server-sent-events) of every event it stores for possible resending. It records how far the client has read in each [topic](realtime-topic.md) it subscribed to, not only the topic of that one event. When a client reconnects with its last cursor, the hub replays every stored event after that position, in order. [Replay](event-replay.md) only reads the cursor. It never changes stored state.

## Example
A browser watches `user:{userId}` for the notification bell. The connection drops, and the browser reconnects with the `id:` value of the last event it received. Using that cursor, the hub sends the `payment.status` events that were published during the outage, oldest first.

## Known gaps
- The spec does not say how the cursor is encoded, or how one value holds positions for several topics.
- The spec does not say how the client sends the cursor back. S51's title mentions "[Last-Event-ID replay ↗](../sw-external-terms.md#last-event-id)", but this page has no rule that names the header.
- The spec does not say what the hub does with a cursor that is malformed or belongs to a different set of topics.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-06, R-12, B-01, B-02, B-06, B-18
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-04
- [baseline-frame](baseline-frame.md)
- [create-event-stream](create-event-stream.md)
- [encode-cursor](encode-cursor.md)
- [event-replay](event-replay.md)
- [realtime-event](realtime-event.md)
- [realtime-hub](realtime-hub.md)
- [realtime-topic](realtime-topic.md)
- [replay-buffer](replay-buffer.md)
- [replay-false](replay-false.md)
- [replay-page](replay-page.md)
- [replayable-event](replayable-event.md)
- [resync-frame](resync-frame.md)
- [sse-event-id](sse-event-id.md)
- [stream-connection](stream-connection.md)
- [stream-frame](stream-frame.md)
- [unusable-cursor-entry](unusable-cursor-entry.md)
<!-- used-by:end -->
