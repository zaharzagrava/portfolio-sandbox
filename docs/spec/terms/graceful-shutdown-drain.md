---
id: graceful-shutdown-drain
title: Drain delay
kind: term
status: draft
aliases: [drain]
defined_for: S54-platform-toolkit
rules_hash: f58ea0d5fedf
---
# Drain delay
## Definition
The drain delay is a wait in the [graceful shutdown sequence](shutdown-sequence.md). It comes right after [readiness turns false](readiness.md) and before the server stops accepting connections. During this wait the pod still serves requests while the [load balancer ↗](../sw-external-terms.md#load-balancer) sees that it is not ready and stops routing to it. Design intent (not stated in the spec): this avoids refusing requests that the load balancer has already sent. The delay is a shutdown timing in the configuration, and [startup validation](startup-validation.md) checks that the drain delay plus the [request-drain timeout](request-drain-timeout.md) is less than the [hard timeout](hard-shutdown-timeout.md).

## Example
[SIGTERM ↗](../sw-external-terms.md#termination-signal) arrives. `/health/ready` starts returning 503, and the drain delay passes while requests are still served. Then the server stops accepting, in-flight requests finish, and the [shutdown tasks](shutdown-tasks.md) run.

## Known gaps
- The spec does not give the default value of the drain delay or the name of its configuration key.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-31
- [S54](../capabilities/S54-platform-toolkit.md): B-10
- [create-graceful-shutdown](create-graceful-shutdown.md)
- [hard-shutdown-timeout](hard-shutdown-timeout.md)
- [in-flight-request](in-flight-request.md)
- [readiness](readiness.md)
- [request-drain-timeout](request-drain-timeout.md)
- [shutdown-sequence](shutdown-sequence.md)
- [shutdown-task](shutdown-task.md)
- [shutdown-tasks](shutdown-tasks.md)
- [startup-validation](startup-validation.md)
<!-- used-by:end -->
