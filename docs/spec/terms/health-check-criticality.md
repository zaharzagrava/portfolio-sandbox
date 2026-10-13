---
id: health-check-criticality
title: Critical pod-local check
kind: term
status: draft
aliases: [critical check, pod-local, shared checks]
defined_for: S54-platform-toolkit
rules_hash: 052c2547559d
---
# Critical pod-local check
## Definition
A critical pod-local check is a [readiness check](readiness.md) for something that belongs to this one pod, and it is marked as critical. When such a check fails, [`/health/ready`](health-probes.md) returns 503 and the [load balancer ↗](../sw-external-terms.md#load-balancer) stops sending traffic to this pod. Checks on shared dependencies, such as the database or the cache, are still reported, but they never fail readiness. This means an outage of one shared store does not take every pod out of rotation at once. Any check that does not settle in time is reported as [`down`](health-check-up.md).

## Example
The database and the cache are both unreachable. `GET /health/ready` still answers 200 and lists both checks as `down`, because they are shared checks. A failing critical pod-local check would make the same call answer 503 instead.

## Known gaps
- The spec does not say which checks are pod-local or critical, or how a check is marked as critical.
- The spec does not say whether a non-critical pod-local check that fails changes readiness.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-19
- [event-loop-lag](event-loop-lag.md)
- [health-controller](health-controller.md)
- [readiness](readiness.md)
<!-- used-by:end -->
