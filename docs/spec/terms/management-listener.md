---
id: management-listener
title: Management listener
kind: term
status: draft
aliases: []
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# Management listener
## Definition
The management listener is a small HTTP listener that serves the three [health probes](health-probes.md) on a separate, configured port. It exists for apps that run no HTTP server of their own, such as a worker that only consumes messages or runs jobs. It is started by [`startManagementListener`](start-management-listener.md) and answers `/health/live`, `/health/ready` and `/health/startup`. This lets the platform probe these apps the same way it probes HTTP apps. That reason is design intent (not stated in the spec).

## Example
A worker with only an event consumer and no HTTP server starts the management listener on its management port (the port number here is illustrative):
```
GET http://worker-pod:9090/health/ready   ->  200, [readiness checks](readiness.md) listed as up/down
```
When [SIGTERM ↗](../sw-external-terms.md#termination-signal) arrives, the worker skips the [HTTP shutdown steps](shutdown-sequence.md). It stops the consumer, [flushes](shutdown-flush.md), closes pools and exits 0 (S54.B-15).

## Known gaps
- The spec does not say when the management listener closes during the shutdown sequence, or whether readiness stays reachable on it while the worker drains.
- The spec does not say whether the management listener serves anything besides the three probes, such as metrics.
- Not confirmed in the code: that the probes on the management listener behave exactly like the ones from [`HealthController`](health-controller.md) (same `HEAD` support, same [problem+json ↗](../sw-external-terms.md#problem-json) errors, `405` with `Allow` for other methods).

## Used by
<!-- used-by:start -->
- [bootstrap-app](bootstrap-app.md)
- [health-probes](health-probes.md)
- [http-pipeline](http-pipeline.md)
- [method-not-allowed](method-not-allowed.md)
- [shutdown-flush](shutdown-flush.md)
- [shutdown-sequence](shutdown-sequence.md)
- [start-management-listener](start-management-listener.md)
<!-- used-by:end -->
