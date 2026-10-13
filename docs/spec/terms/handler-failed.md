---
id: handler-failed
title: HANDLER_FAILED
kind: term
status: draft
aliases: []
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# HANDLER_FAILED
## Definition
`HANDLER_FAILED` is the reason code for an event that a consumer's handler failed to process within the [consumer attempt budget](consumer-attempt-budget.md). The event goes to the consumer's [`<consumer>.dlq` topic](dead-letter-topic.md), and the consumer [commits the offset ↗](../sw-external-terms.md#kafka-offset-commit) past it. The rest of the [partition ↗](../sw-external-terms.md#kafka-partition) keeps flowing. An [operator](operator) can later return the event to its [source topic ↗](../sw-external-terms.md#kafka-topic) with [`pnpm projections:redrive`](dead-letter-redrive.md). The other dead-letter codes are [`SCHEMA_INVALID`](schema-invalid) and [`UNSUPPORTED_VERSION`](unsupported-version).

## Example
```
topic:  <consumer>.dlq
reason: HANDLER_FAILED
after:  3 attempts (consumer attempt budget)
```
The source offset is committed past the event, so the next event in the partition is processed (S53.B-12).

## Known gaps
- The spec does not say whether the dead-letter message records the last error text or the attempt count. Its exact field names are not specified either.
- Not confirmed in the code: the redrive header name. AS-63 uses `x-redriven-count`, but `redrive.ts` uses `x-redrive-count`. The spec flags this mismatch as unresolved.

## Used by
<!-- used-by:start -->
- [consumer-attempt-budget](consumer-attempt-budget.md)
- [dead-letter-topic](dead-letter-topic.md)
- [event-sink](event-sink.md)
<!-- used-by:end -->
