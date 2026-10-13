---
id: liveness-heartbeat
title: Liveness heartbeat
kind: term
status: draft
aliases: [heartbeat, silent heartbeat]
defined_for: S54-platform-toolkit
rules_hash: 98db50544236
---
# Liveness heartbeat
## Definition
The [liveness](health-probes.md) heartbeat is an in-process signal that is expected to fire on a regular schedule while the process is still making progress. If it goes silent, [`/health/live`](health-probes.md) fails. This is the second of the only two reasons liveness may fail; the other is [event-loop p99 lag](event-loop-lag.md). Like the rest of liveness, it uses no external store. Design intent (not stated in the spec): it catches a process that is stuck in a way that [lag sampling](event-loop-lag.md) alone might not show.

## Example
The heartbeat stops updating, for example because the process is [wedged ↗](../sw-external-terms.md#deadlock). The next `GET /health/live` reports failure, and the platform restarts the pod. A cache that cannot be reached does not affect the heartbeat.

## Known gaps
- The spec does not say what emits the heartbeat, how often it fires, or how long it must be silent before liveness fails.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-18
- [event-loop-lag](event-loop-lag.md)
- [health-probes](health-probes.md)
<!-- used-by:end -->
