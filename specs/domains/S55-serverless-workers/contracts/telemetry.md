# Contract: logs, metrics, trace

- `log(level, message, fields)`: JSON line with `level`, `message`, `time` (injected clock), `traceId`, and `fields`. Failure logs carry message ID, function, queue, receive count, error class and message; never the body or attribute values.
- `metric(namespace, name, value, unit, dimensions)`: embedded-metric-format line; at most 3 dimensions; finite value; unit from the CloudWatch list. Invalid calls write nothing to the metric stream, log a warning, never throw.
- Standard metrics (namespace `Marketplace/Lambda`, dimensions `function`, `queue`, plus `outcome` on `RecordsFailed`): `RecordsProcessed`, `RecordsFailed` (`permanent` | `transient` | `in_progress`), `InvocationMs`, `DeadLettered`, `FifoGroupOrderBroken`, `IdempotencyReplay`, `IdempotencyCompletionFailed`, `DeadLetterHandlerFailed`.
- Trace: the `traceparent` message attribute (W3C) becomes the parent of the invocation span; the trace ID and message ID are on every log line of the invocation.
