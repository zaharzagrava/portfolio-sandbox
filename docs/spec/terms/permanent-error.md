---
id: permanent-error
title: Permanent error
kind: term
status: draft
aliases: [permanent errors]
defined_for: S53-events-projections
rules_hash: f4cd5588b163
---
# Permanent error
## Definition
A permanent error is a failure in a [consumer's handler](job-handler.md) that retrying will not fix, such as a bug or data the handler can never accept. The consumer still tries the event up to its [attempt budget](consumer-attempt-budget.md). After that, it [dead-letters ↗](../sw-external-terms.md#dead-letter-queue) the event with [`HANDLER_FAILED`](handler-failed) and [commits the offset ↗](../sw-external-terms.md#kafka-offset-commit) past it. A permanent error is different from an unreachable [sink](event-sink). In that case [the partition pauses](partition-pause.md) and nothing is dead-lettered.

## Example
A handler throws on every call for one event. The consumer attempts that event 3 times (the consumer attempt budget). It then writes the event to `<consumer>.dlq` with `HANDLER_FAILED` and moves on to the next offset (S53.B-12).

## Known gaps
- The spec does not say how the consumer tells a permanent error from a transient one. Examples would be an error class, a flag, or a list of error types. It also does not say what happens to an error that is neither.
- The spec does not say why a permanent error is still retried up to the attempt budget, and not dead-lettered at once.
- The spec does not say whether a handler that exceeds the [handler timeout](handler-timeout.md) counts as a permanent error.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-12
- [consumer-attempt-budget](consumer-attempt-budget.md)
- [dead-letter-reason-code](dead-letter-reason-code.md)
- [handler-timeout](handler-timeout.md)
- [job-handler](job-handler.md)
- [partition-pause](partition-pause.md)
<!-- used-by:end -->
