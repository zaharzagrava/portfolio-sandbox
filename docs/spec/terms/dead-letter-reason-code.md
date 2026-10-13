---
id: dead-letter-reason-code
title: Dead-letter reason code
kind: term
status: draft
aliases: [reason code]
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# Dead-letter reason code
## Definition
A dead-letter reason code is the label an [event consumer](event-consumer.md) attaches when it sends an event to its [`<consumer>.dlq`](dead-letter-topic.md) topic instead of applying it. It tells operators why the consumer refused the event. The spec names three codes. [`SCHEMA_INVALID`](schema-invalid.md) means the event payload fails its schema. [`UNSUPPORTED_VERSION`](unsupported-version.md) means the event's version is above the consumer's highest supported version. [`HANDLER_FAILED`](handler-failed.md) means the handler kept throwing a [permanent error](permanent-error.md) until the [consumer attempt budget](consumer-attempt-budget.md) ran out.

Some cases never get a reason code because they are not dead-lettered. If the consumer does not handle an event type, the event is counted as `ignored` and its offset is committed. If a [sink](event-sink.md) is unreachable, the [partition pauses](partition-pause.md) and the events are applied later.

## Example
A batch of 5 events reaches a consumer, and the third event's payload fails its schema (S53.B-09). The consumer writes the third event to `<consumer>.dlq` with `SCHEMA_INVALID` and applies the other four. Later, an operator runs [`pnpm projections:redrive`](dead-letter-redrive.md), which sends it back to its source topic with its original key (S53.B-14).

## Known gaps
- The spec does not say which field or header of the dead-letter message carries the reason code.
- The spec does not say whether these three codes are the full list. Sink-specific failures (AS-66 to AS-70, AS-72) have tests but no rule on this page.
- The spec does not say whether the `dlq_total` metric is broken down by reason code.

## Used by
<!-- used-by:start -->
- [consumer-attempt-budget](consumer-attempt-budget.md)
- [event-consumer](event-consumer.md)
- [event-sink](event-sink.md)
- [partition-pause](partition-pause.md)
- [permanent-error](permanent-error.md)
- [unsupported-version](unsupported-version.md)
<!-- used-by:end -->
