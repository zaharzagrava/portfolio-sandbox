---
id: trace-id
title: traceId
kind: term
status: draft
aliases: [trace is active]
defined_for: problem-json-errors
rules_hash: 0b1a7941f9d9
---
# traceId
## Definition
`traceId` is an optional member of the [error body ↗](../sw-external-terms.md#problem-json). It appears only when a [distributed trace ↗](../sw-external-terms.md#distributed-trace) is active for the request. It lets an engineer jump from a client's error report to the matching trace. It sits next to [`requestId`](request-id.md) and does not replace it.

## Example
```json
{ "code": "internal_error", "requestId": "0192f0c1-...", "traceId": "4bf92f3577b34da6a3ce929d0e0e4736" }
```
(Values are illustrative. Other required members are omitted here.)

## Known gaps
- The spec does not say which tracing system or ID format produces `traceId`.
- The spec does not say what makes a trace "active", for example [sampling rules ↗](../sw-external-terms.md#trace-sampling).

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-20
<!-- used-by:end -->
