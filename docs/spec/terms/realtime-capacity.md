---
id: realtime-capacity
title: realtime_capacity (503)
kind: term
status: draft
aliases: [realtime_capacity]
defined_for: realtime-topic-stream
rules_hash: e3b0c44298fc
---
# realtime_capacity (503)
## Definition
`realtime_capacity` is the error code the [realtime stream](stream-connection.md) returns, with status `503`, when an instance already holds as many connections as its [instance connection limit](realtime-instance-limit.md) allows. The refusal is about the server's capacity, not about who the viewer is. It is a different error from [`429 too_many_connections`](too-many-connections.md), which is returned when one user holds too many connections. Design intent (not stated in the spec): `503` tells the client that the server is temporarily full and that its own request was not wrong.

## Example
A browser opens the stream for topic `user:{userId}`. The instance it reaches is already full, so it answers:
```
HTTP/1.1 503
code: realtime_capacity
```

## Known gaps
- The spec does not say whether the response includes a [`Retry-After` ↗](../sw-external-terms.md#retry-after) header or a [`retryAfterSeconds`](retry-after-seconds.md) member, or what the response body looks like.
- The spec does not say whether the check against the user's connection limit or the instance limit runs first, so it is unclear which error a request gets when both limits are hit.
- The spec does not say how [W03](../capabilities/W03-cart-checkout-orders.md) should react. For example, it does not say whether the client should retry, back off or fall back.

## Used by
<!-- used-by:start -->
- [realtime-instance-limit](realtime-instance-limit.md)
- [stream-connection](stream-connection.md)
<!-- used-by:end -->
