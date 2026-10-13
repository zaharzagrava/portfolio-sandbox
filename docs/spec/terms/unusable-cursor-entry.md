---
id: unusable-cursor-entry
title: Unusable Last-Event-ID entry
kind: term
status: draft
aliases: [unusable entry]
defined_for: S51-realtime-push
rules_hash: 70939beb171a
---
# Unusable Last-Event-ID entry
## Definition
The [`Last-Event-ID` ↗](../sw-external-terms.md#last-event-id) header holds a [replay cursor](replay-cursor.md) that names a position for every [topic](realtime-topic.md) the client has seen. An unusable entry is a part of that cursor the [hub](realtime-hub.md) cannot use. The hub ignores that entry and still uses the rest of the header. If the whole header is longer than the length limit, the hub ignores all of it. In neither case does the hub refuse the connection.

## Example
A client reconnects to two topics. Its cursor has a valid position for one topic and a garbled entry for the other (illustrative). The hub replays the first topic from its position and treats the second as if no cursor had been sent for it.

## Known gaps
- The spec does not say what makes an entry unusable. Possible causes include a malformed position, a topic the client did not request, or a position from an unknown stream.
- The spec does not say what a topic with an ignored entry receives: a [baseline frame](baseline-frame.md), a [`resync` frame](resync-frame.md), or nothing.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-10, R-34
- [baseline-frame](baseline-frame.md)
- [realtime-hub](realtime-hub.md)
- [realtime-topic](realtime-topic.md)
- [replay-cursor](replay-cursor.md)
- [resync-frame](resync-frame.md)
<!-- used-by:end -->
