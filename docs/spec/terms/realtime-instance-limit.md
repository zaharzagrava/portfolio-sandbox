---
id: realtime-instance-limit
title: Instance connection limit
kind: term
status: draft
aliases: [instance at its limit]
defined_for: realtime-topic-stream
rules_hash: 22dfea9be34c
---
# Instance connection limit
## Definition
The instance connection limit is the maximum number of [stream connections](stream-connection.md) that one instance of the [realtime hub](realtime-hub.md) will hold open at the same time. When an instance reaches this limit, it refuses new connections with [`503 realtime_capacity`](realtime-capacity.md). This limit is separate from the limit on how many connections a single user may open, and the two limits are checked independently. Design intent (not stated in the spec): the limit protects each instance from running out of memory or sockets when too many viewers connect.

## Example
An instance at its limit gets a new connection request for [`user:{userId}`](realtime-topic.md) and answers `503 realtime_capacity`. The same user could still be under their own limit of 20 connections, but the request is refused because the instance is full.

## Known gaps
- The spec does not say what the instance limit is or how it is configured.
- The spec does not say whether the limit counts connections or topic subscriptions. A single connection can name several topics.
- The spec does not say whether the [load balancer ↗](../sw-external-terms.md#load-balancer) sends refused clients to another instance.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-25
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-07
- [realtime-capacity](realtime-capacity.md)
- [realtime-config](realtime-config.md)
- [realtime-hub](realtime-hub.md)
- [stream-connection](stream-connection.md)
- [too-many-connections](too-many-connections.md)
- [user-connection-cap](user-connection-cap.md)
<!-- used-by:end -->
