---
id: start-management-listener
title: startManagementListener
kind: term
status: draft
aliases: []
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# startManagementListener
## Definition
`startManagementListener` is the function that starts the [management listener](management-listener.md). It serves the [liveness, readiness and startup probes](health-probes.md) on the configured management port. Apps with no [HTTP surface](http-surface.md) use it, for example a worker that only consumes messages or runs jobs. It lets the platform probe these apps the same way it probes HTTP apps. That reason is design intent (not stated in the spec).

## Example
A worker that has only an event consumer calls `startManagementListener`, so its probes answer on the management port (the port number here is illustrative):
```
GET http://worker-pod:9090/health/live    -> 200
GET http://worker-pod:9090/health/ready   -> 200, checks listed as up/down
```

## Known gaps
- The spec does not say when `startManagementListener` is called during [`bootstrapApp`](bootstrap-app.md), or whether apps that already have an HTTP server also call it.
- The spec does not say when the management listener closes during the [shutdown sequence](shutdown-sequence.md). S54.B-15 lists only these worker steps: stop the consumer, flush, close pools, exit.
- Not confirmed in the code: that the probes it serves give the same results as [`HealthController`](health-controller.md), including `HEAD` support.

## Used by
<!-- used-by:start -->
- [health-probes](health-probes.md)
- [http-surface](http-surface.md)
- [management-listener](management-listener.md)
- [shutdown-sequence](shutdown-sequence.md)
<!-- used-by:end -->
