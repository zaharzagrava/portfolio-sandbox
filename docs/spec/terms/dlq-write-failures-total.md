---
id: dlq-write-failures-total
title: dlq_write_failures_total
kind: term
status: draft
aliases: []
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# dlq_write_failures_total
## Definition
`dlq_write_failures_total` is a metric owned by [S53](s53-outbox-task-queue). Its name suggests it counts the times a consumer tried to write an event to its [dead-letter topic](dead-letter-topic) and failed. This matters because a dead letter that is never written could be lost if the [offset ↗](../sw-external-terms.md#kafka-offset-commit) still moves past it. The spec only lists the metric's name, so treat its exact meaning as inferred from that name.

## Example
Illustrative: the Kafka broker rejects a write to `<consumer>.dlq` for an event that failed with `[HANDLER_FAILED](handler-failed.md)`. In that case, `dlq_write_failures_total` would go up by one.

## Known gaps
- The spec does not say what the consumer does when a dead-letter write fails. It could retry, [pause the partition](partition-pause.md), or commit the offset anyway. No rule covers this, so it is unknown whether the event can be lost.
- The spec does not say which [labels ↗](../sw-external-terms.md#metric-labels) the metric carries or when it is incremented. Both are known only from the metric's name.

## Used by
<!-- used-by:start -->
- [partition-pause](partition-pause.md)
<!-- used-by:end -->
