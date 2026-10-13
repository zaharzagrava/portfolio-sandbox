---
id: health-probes
title: Health probes
kind: term
status: draft
aliases: [health probe]
defined_for: idempotency-key
rules_hash: 52a0779ea4f7
---
# Health probes
## Definition
Health probes are checks that a service exposes so the platform running it can tell whether it is alive and ready for traffic. The [platform toolkit](platform-toolkit.md) provides them as a shared building block. This way every backend service reports its health in the same way. That reason is design intent (not stated in the spec). The toolkit lists them next to [graceful shutdown ↗](../sw-external-terms.md#graceful-shutdown). A service that is shutting down usually reports itself as not ready (general engineering knowledge).

## Example
Illustrative only: the orchestrator calls a service's readiness probe before it sends traffic to a new instance. While the probe fails, that instance gets no requests. The spec does not name the probe endpoints, so none are given here.

## Known gaps
- The spec does not say which probes exist (for example liveness, readiness, startup) or what their endpoints are.
- The spec does not say what each probe checks, for example the database or other dependencies.
- The spec does not say how the probes behave during graceful shutdown.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): B-12
- [S54](../capabilities/S54-platform-toolkit.md): R-20, B-08, B-09
- [health-check-up](health-check-up.md)
- [health-controller](health-controller.md)
- [liveness-heartbeat](liveness-heartbeat.md)
- [management-listener](management-listener.md)
- [platform-toolkit](platform-toolkit.md)
- [start-management-listener](start-management-listener.md)
<!-- used-by:end -->
