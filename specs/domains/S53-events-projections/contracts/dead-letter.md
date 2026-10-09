# Contract: dead letters, failure classes, redrive

Topic `<consumer>.dlq`; key and value are the original bytes.

| Header | Meaning |
|---|---|
| x-source-topic, x-source-partition, x-source-offset | origin |
| x-consumer | group name |
| x-dlq-reason-code | `INVALID_ENVELOPE`, `INVALID_PAYLOAD`, `UNSUPPORTED_VERSION`, `INVALID_AGGREGATE_ID`, `HANDLER_FAILED` |
| x-dlq-reason | ≤ 500 chars, error class + schema paths, never values |
| x-attempts | handler attempts used |
| x-failed-at | ISO time (injected clock) |
| x-redrive-count | added by redrive; refused at 3 |

## Failure classes
| Class | Examples | Behaviour |
|---|---|---|
| transient | timeout, connection loss, throttling, `SinkBackpressureError(retryAfterMs)`, handler timeout | pause partition, retry with full-jitter backoff (200 ms to 5 s), never dead-letter |
| permanent / unclassified | `PermanentError`, schema failure, thrown unknown error | attempt budget (default 3) then DLQ `HANDLER_FAILED` |
| skipped | unknown `type` | offset advances, counted `ignored` |

If the DLQ write fails the offset is not committed and `dlq_write_failures_total` increments.

## Commands
`projections:redrive --consumer <name> [--limit n]`, `projections:rebuild`, `projections:promote`, `projections:rollback`, `outbox:requeue`.
