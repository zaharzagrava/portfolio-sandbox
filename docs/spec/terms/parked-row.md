---
id: parked-row
title: Parked row
kind: term
status: draft
aliases: [park, parked]
defined_for: outbox-task-queue
rules_hash: d52d755a5d5d
---
# Parked row
## Definition
A parked row is an [outbox row](inbox-table.md) that the [relay](outbox-relay.md) has stopped trying to publish to [Kafka ↗](../sw-external-terms.md#kafka-message). The relay parks a row when it has used up its allowed failed attempts. It also parks a row at once when the broker returns a [non-retryable error](non-retryable-job-error.md). A parked row does not block later rows that share its [`aggregateId`](aggregate-id.md), so those rows keep flowing.

## Example
The relay fails 10 times in a row to publish a `product` event for `aggregateId` `prod-42` (illustrative id). The relay parks that row. The next event for `prod-42` is then published normally and is no longer held back.

## Known gaps
- The spec does not say how a parked row is found, alerted on, retried or deleted, or whether [replay](event-replay.md) covers it.
- The spec does not say which broker errors count as non-retryable.
- The spec does not say how consumers deal with the gap in per-aggregate order that a skipped parked row leaves.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-13
- [outbox-task-queue](../concepts/outbox-task-queue.md): C-07
- [bounded-batch](bounded-batch.md)
- [event-replay](event-replay.md)
- [inbox-table](inbox-table.md)
- [non-retryable-broker-error](non-retryable-broker-error.md)
- [non-retryable-job-error](non-retryable-job-error.md)
- [outbox-purge-job](outbox-purge-job.md)
- [outbox-relay](outbox-relay.md)
- [pending-row](pending-row.md)
- [per-aggregate-ordering](per-aggregate-ordering.md)
- [published-row](published-row.md)
<!-- used-by:end -->
