---
id: dlq-total
title: dlq_total
kind: term
status: draft
aliases: []
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# dlq_total
## Definition
`dlq_total` is a metric owned by [S53](s53-outbox-task-queue) that counts events written to a [dead-letter topic](dead-letter-topic). It goes up when a consumer gives up on an event and moves it to [`<consumer>.dlq`](dead-letter-topic.md), for example with [`SCHEMA_INVALID`](schema-invalid.md), [`UNSUPPORTED_VERSION`](unsupported-version.md) or [`HANDLER_FAILED`](handler-failed.md). It does not count events marked [`ignored`](consumer-outcomes.md), and it does not count events held back by a [partition pause](partition-pause). If it keeps rising, events are being skipped and need an operator to look at them.

## Example
A batch of 5 events reaches a consumer and the third fails its schema (S53.B-09). The third event is dead-lettered with `SCHEMA_INVALID`, so `dlq_total` goes up by one. The other four events apply and do not change this metric.

## Known gaps
- The spec does not say which labels `dlq_total` carries, such as consumer, reason code or event type.
- The spec does not say whether events sent back by redrive are subtracted from or kept apart in this count.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
