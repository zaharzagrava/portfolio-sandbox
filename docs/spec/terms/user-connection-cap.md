---
id: user-connection-cap
title: Per-user connection cap
kind: term
status: draft
aliases: [cap, connection cap]
defined_for: realtime-topic-stream
rules_hash: e3b0c44298fc
---
# Per-user connection cap
## Definition
The per-user connection cap is the most [stream connections](stream-connection.md) that one user may hold open at the same time. If the user already holds that many, [the hub](realtime-hub.md) refuses a new one with [`429 too_many_connections`](too-many-connections.md). This cap is separate from the [instance connection limit](realtime-instance-limit.md). That limit protects one instance as a whole and answers [`503 realtime_capacity`](realtime-capacity.md). Design intent (not stated in the spec): the cap stops one user, for example someone with many open tabs, from using up a shared instance's capacity.

## Example
A shopper has 20 tabs open, and each tab holds a stream connection for `user:{userId}`. A 21st tab tries to connect and gets `429 too_many_connections`. Once one of the other tabs closes, a new connection can be admitted.

## Known gaps
- The spec does not say whether the cap counts a user's connections across all instances or on one instance only.
- The spec does not say whether the cap applies to anonymous viewers, or which identity it would use to count them.
- The spec does not say which check runs first when a user is at the cap and the instance is also at its limit (`429` or `503`).

## Used by
<!-- used-by:start -->
- [realtime-hub](realtime-hub.md)
- [realtime-instance-limit](realtime-instance-limit.md)
- [stream-connection](stream-connection.md)
- [viewer](viewer.md)
<!-- used-by:end -->
