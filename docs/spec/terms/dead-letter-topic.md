---
id: dead-letter-topic
title: Dead-letter topic (<consumer>.dlq)
kind: term
status: draft
aliases: [<consumer>.dlq, dlq]
defined_for: S53-events-projections
rules_hash: a2c89f25e53d
---
# Dead-letter topic (<consumer>.dlq)
## Definition
A dead-letter topic is a [Kafka topic ↗](../sw-external-terms.md#kafka-topic) named `<consumer>.dlq`, and each [event consumer](event-consumer) has its own. When the consumer cannot apply an event, it writes the event there with a [dead-letter reason code](dead-letter-reason-code) and [commits its offset ↗](../sw-external-terms.md#kafka-offset-commit) past it, so one bad event does not block the rest of the [partition ↗](../sw-external-terms.md#kafka-partition). An [operator](operator) can later [redrive](dead-letter-redrive) the dead letters, which sends each one back to the topic it was first read from with its original [key](event-key). Not every problem dead-letters an event: if the consumer does not handle an event type, the event is counted [`ignored`](consumer-outcomes.md) and skipped, and if the system the consumer writes its results to is unreachable, the consumer uses a [partition pause](partition-pause) instead. Dead-lettering is counted by the [`dlq_total`](dlq-total.md) metric.

## Example
A consumer gets a batch of 5 events, and the third one fails its schema. The third event goes to `<consumer>.dlq` with reason [`SCHEMA_INVALID`](schema-invalid.md), and the other four apply (S53.B-09). Later, an operator runs [`pnpm projections:redrive`](dead-letter-redrive.md). Each dead letter goes back to its source topic, such as `<aggregateType>.events`, with its original key (S53.B-14).

## Known gaps
- The spec does not say what the consumer does when writing to the dead-letter topic fails. The [`dlq_write_failures_total`](dlq-write-failures-total.md) metric exists, but no rule covers this case.
- The spec does not say how long `<consumer>.dlq` keeps messages, or which fields a dead-letter message carries besides the reason code.
- Not confirmed in the code: the name of the redrive header. AS-63 uses `x-redriven-count`, but `redrive.ts` uses [`x-redrive-count`](redrive-count-header.md). The spec marks this mismatch as unresolved.

## Used by
<!-- used-by:start -->
- [consumer-attempt-budget](consumer-attempt-budget.md)
- [dead-letter-redrive](dead-letter-redrive.md)
- [event-sink](event-sink.md)
- [handler-failed](handler-failed.md)
- [partition-pause](partition-pause.md)
- [redrive-count-header](redrive-count-header.md)
- [source-topic](source-topic.md)
<!-- used-by:end -->
