---
id: consumer-attempt-budget
title: Consumer attempt budget
kind: term
status: draft
aliases: [attempt budget]
defined_for: S53-events-projections
rules_hash: b62decb42f75
---
# Consumer attempt budget
## Definition
The consumer attempt budget is the number of times an [event consumer](event-consumer) tries one event before it gives up on it. When a handler keeps failing with a [permanent error](permanent-error), the consumer stops once the budget is used up. It then [dead-letters](dead-letter-topic.md) the event with [`HANDLER_FAILED`](handler-failed) and [commits the offset ↗](../sw-external-terms.md#kafka-offset-commit) past it, so later events can still be processed. This capability checks the budget as part of its configuration at [startup](startup-validation).

## Example
A handler throws a [permanent error](permanent-error.md) every time it is called for one event. The consumer attempts that event 3 times, which is the configured budget. It then writes the event to [`<consumer>.dlq`](dead-letter-topic.md) with [`HANDLER_FAILED`](handler-failed.md) and moves on to the next offset (S53.B-12).

## Known gaps
- The spec does not say whether attempts are counted only within one batch run, or whether the count carries over a redelivery or a consumer restart.
- The spec does not say whether the consumer waits between attempts, or for how long.
- The spec does not state the budget as a rule. It appears only in the configuration list and in S53.B-12, and the page's own Known gaps say the consumer-failure scenarios have no rule.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-16
- [dead-letter-reason-code](dead-letter-reason-code.md)
- [dead-letter-topic](dead-letter-topic.md)
- [failover-timeline-entry](failover-timeline-entry.md)
- [handler-failed](handler-failed.md)
- [handler-timeout](handler-timeout.md)
- [ledger-settle-order-job](ledger-settle-order-job.md)
- [permanent-error](permanent-error.md)
- [queue-refusal](queue-refusal.md)
- [settlement-journal](settlement-journal.md)
<!-- used-by:end -->
