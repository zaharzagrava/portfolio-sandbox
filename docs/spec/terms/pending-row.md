---
id: pending-row
title: Pending row (outbox)
kind: term
status: draft
aliases: [pending, pending rows]
defined_for: S53-events-projections
rules_hash: 5347088b89e4
---
# Pending row (outbox)
## Definition
A pending row is an [outbox row](event-row.md) whose state change has committed but which is not published yet. Every row starts as pending when [`append`](outbox-append.md) commits in the caller's transaction. A rollback leaves no row at all. The [outbox relay](outbox-relay.md) claims pending rows under a [lease](concurrency-lease.md), sends them to Kafka and marks them published. A pending row that keeps failing waits for its [retry backoff](job-retry-delay.md) and holds back later rows of the same [aggregate](aggregate-id.md). If it fails too often, or hits a [non-retryable broker error](non-retryable-broker-error.md), it becomes a [parked row](parked-row.md).

## Example
Aggregate A goes from version 3 to 4, and the same transaction appends `fixtures.item_changed`. After the commit, exactly one pending row exists (S53.B-01). The broker is down, so the relay's first try fails. The row stays pending with `attempts` 1 and a future `nextAttemptAt`, and it is published once the broker is back (S53.B-04).

## Known gaps
- The spec does not say whether the `outbox_pending` metric also counts rows that are waiting on backoff or held under a relay lease.
- The spec does not say whether a row being retried counts as a separate state or simply stays pending. The lifecycle lists only pending, published and parked.
- The spec does not say whether task rows go through the same pending state as event rows. The lifecycle names only "outbox row".

## Used by
<!-- used-by:start -->
- [aggregate-id](aggregate-id.md)
- [aggregate-type-events-topic](aggregate-type-events-topic.md)
- [bounded-batch](bounded-batch.md)
- [concurrency-lease](concurrency-lease.md)
- [domain](domain.md)
- [event-row](event-row.md)
- [job-retry-delay](job-retry-delay.md)
- [non-retryable-broker-error](non-retryable-broker-error.md)
- [outbox-relay](outbox-relay.md)
- [parked-row](parked-row.md)
- [published-row](published-row.md)
<!-- used-by:end -->
