---
id: event-loop-lag
title: Event-loop p99 lag
kind: term
status: draft
aliases: [event-loop, p99]
defined_for: S54-platform-toolkit
rules_hash: cb5d49be9711
---
# Event-loop p99 lag
## Definition
Event-loop p99 lag measures how long callbacks wait before the [Node.js event loop ↗](../sw-external-terms.md#event-loop) runs them, taken at the [99th percentile ↗](../sw-external-terms.md#percentile). A high value means the process is blocked and cannot serve work on time. [`/health/live`](health-probes.md) uses it as one of only two reasons to report the process as not alive. If the lag goes above the [liveness threshold](health-check-criticality.md), the liveness probe fails and the orchestrator can restart the process. The check uses only in-process state, so a database outage cannot make it fail.

## Example
A handler runs a long synchronous loop and blocks the event loop. The p99 lag rises above 10 000 ms, so `GET /health/live` starts failing. A slow database alone never causes this, because liveness does not touch any store.

## Known gaps
- Not confirmed in the code: that liveness reads the same value the page exports as the metric `nodejs_eventloop_lag_p99_ms`.
- The spec does not say how long the measurement window is or how often the lag is sampled.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-18
- [health-check-criticality](health-check-criticality.md)
- [liveness-heartbeat](liveness-heartbeat.md)
<!-- used-by:end -->
