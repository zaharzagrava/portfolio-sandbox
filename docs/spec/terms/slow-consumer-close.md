---
id: slow-consumer-close
title: Slow and stalled close reasons
kind: term
status: draft
aliases: [slow, slow consumer]
defined_for: S51-realtime-push
rules_hash: 52981a3ae7d3
---
# Slow and stalled close reasons
## Definition
`slow` and `stalled` are the two reasons [the hub](realtime-hub.md) uses to close a [stream connection](stream-connection.md) that cannot keep up. `slow` means too much data is waiting to be written to the client. `stalled` means one write stayed blocked for longer than the configured stall limit. Only the lagging connection is closed. Other viewers of the same [topic](realtime-topic.md) keep receiving events. Design intent (not stated in the spec): this stops one slow reader from using up memory or holding back the instance.

## Example
A viewer stops reading its stream, and a publisher then sends 5 MiB of events. The pending data goes over 1 MiB, so the hub closes that connection with reason `slow`. The other connections are not affected (S51.B-14).

## Known gaps
- The spec does not say how the client learns the close reason: through a frame before the close, or only in logs and metrics.
- The spec does not say whether a client closed for `slow` or `stalled` can resume with `Last-Event-ID`, or whether it gets a `resync`.
- The spec does not say how these limits apply during replay. A replay with a buffer limit of 10 and 100 events stays open and delivers all of them (S51.B-15), so replay seems to be flow-controlled rather than closed.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-26
- [realtime-hub](realtime-hub.md)
- [realtime-topic](realtime-topic.md)
- [stream-connection](stream-connection.md)
<!-- used-by:end -->
