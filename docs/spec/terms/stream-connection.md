---
id: stream-connection
title: Stream connection
kind: term
status: draft
aliases: [stream, stream connections]
defined_for: realtime-topic-stream
rules_hash: 60a39393059d
---
# Stream connection
## Definition
A stream connection is one open [server-sent events (SSE) ↗](../sw-external-terms.md#server-sent-events) connection between a viewer's browser and the stream endpoint. It names the [topics](realtime-topic.md) it wants, and the [hub](realtime-hub.md) admits it for all of them or refuses it entirely. While it stays open, it carries [stream frames](stream-frame.md) for those topics only. If it drops, the browser reconnects with its [replay cursor](replay-cursor.md) to get the missed events in order, or it gets a message telling it to reload its state from scratch instead. Each open connection counts toward the most connections one user may hold at once and the most connections one server instance will accept.

## Example
In W03, a signed-in shopper's browser opens a stream connection for `user:{userId}`. The hub admits it and answers:
```
HTTP/1.1 200
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
```
After that, `payment.status` events published by S13 arrive on this connection. The page does not need a reload.

## Known gaps
- The spec does not say what path the stream endpoint uses, or how topics are named in the request.
- The spec does not say when the hub closes an idle or slow connection. The stall limit and `revoke` are described only on the S51 page.
- The spec does not say whether a revoked or closed connection can resume on another instance with the same cursor.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): B-14
- [W03](../capabilities/W03-cart-checkout-orders.md): B-20
- [cart-badge](cart-badge.md)
- [create-event-stream](create-event-stream.md)
- [invalid-query](invalid-query.md)
- [invalid-topics](invalid-topics.md)
- [realtime-capacity](realtime-capacity.md)
- [realtime-hub](realtime-hub.md)
- [realtime-instance-limit](realtime-instance-limit.md)
- [realtime-listener](realtime-listener.md)
- [realtime-policy-unavailable](realtime-policy-unavailable.md)
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
- [realtime-topic](realtime-topic.md)
- [realtime-unavailable](realtime-unavailable.md)
- [ref-counted-fan-out](ref-counted-fan-out.md)
- [replay-cursor](replay-cursor.md)
- [resync-frame](resync-frame.md)
- [slow-consumer-close](slow-consumer-close.md)
- [stream-frame](stream-frame.md)
- [too-many-connections](too-many-connections.md)
- [user-connection-cap](user-connection-cap.md)
- [viewer](viewer.md)
<!-- used-by:end -->
