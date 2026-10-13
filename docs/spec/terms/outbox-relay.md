---
id: outbox-relay
title: Outbox relay
kind: term
status: draft
aliases: [relay]
defined_for: outbox-task-queue
rules_hash: 5d842d8c945f
---
# Outbox relay
## Definition
The outbox relay is the process that reads committed [outbox rows](inbox-table.md) and publishes them to [Kafka ↗](../sw-external-terms.md#kafka-message). It [claims rows under a lease](job-lease.md), so two relay instances do not send the same row at the same time. It retries failed sends with [backoff and jitter](jitter.md). While a row is retrying, it holds back later rows that belong to the same business entity. After too many failures, or after a [non-retryable broker error](non-retryable-job-error.md), it sets the row aside for manual handling, so the row stops blocking later rows for that entity.

## Example
For one outbox row, the relay sends the [envelope JSON](event-envelope.md) to Kafka with the key and [headers ↗](../sw-external-terms.md#kafka-headers) below (all values are illustrative):
```
key: prod_123
eventId: 7f3c…   type: product.updated   version: 2   [traceparent ↗](../sw-external-terms.md#traceparent): 00-…
```
If the send fails, it waits a [full-jitter backoff](jitter.md) (base 1 s, cap 60 s) and tries again. After 10 failed attempts, it parks the row.

## Known gaps
- The spec does not say whether the relay polls the outbox table or uses [CDC ↗](../sw-external-terms.md#change-data-capture). The S53 summary says "outbox/CDC → Kafka".
- The spec does not say which Kafka topic each event type goes to.
- The spec does not say who looks at parked rows or how they get republished. It may happen through replay, but no rule says so.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-09, R-14, B-03, B-04, B-06, B-20
- [outbox-task-queue](../concepts/outbox-task-queue.md): C-04, C-05
- [request-context](../concepts/request-context.md): C-07
- [aggregate-id](aggregate-id.md)
- [aggregate-type](aggregate-type.md)
- [at-least-once-delivery](at-least-once-delivery.md)
- [bounded-batch](bounded-batch.md)
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [consumer-highest-version](consumer-highest-version.md)
- [domain](domain.md)
- [event-backbone](event-backbone.md)
- [event-consumer](event-consumer.md)
- [event-envelope](event-envelope.md)
- [event-id](event-id.md)
- [event-key](event-key.md)
- [event-row](event-row.md)
- [event-too-large-error](event-too-large-error.md)
- [inbox-table](inbox-table.md)
- [jitter](jitter.md)
- [job-lease](job-lease.md)
- [ledger-events-topic](ledger-events-topic.md)
- [non-retryable-broker-error](non-retryable-broker-error.md)
- [non-retryable-job-error](non-retryable-job-error.md)
- [outbox-append-task](outbox-append-task.md)
- [outbox-append](outbox-append.md)
- [outbox-rollback](outbox-rollback.md)
- [parked-row](parked-row.md)
- [payment-succeeded-event](payment-succeeded-event.md)
- [pending-row](pending-row.md)
- [per-aggregate-ordering](per-aggregate-ordering.md)
- [published-row](published-row.md)
- [relay-cdc-mode](relay-cdc-mode.md)
- [relay-poller-mode](relay-poller-mode.md)
- [topic-policy-error](topic-policy-error.md)
- [unregistered-aggregate-type-error](unregistered-aggregate-type-error.md)
<!-- used-by:end -->
