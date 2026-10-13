---
id: consumer-effects
title: Consumer effects
kind: term
status: draft
aliases: [effect]
defined_for: projection-and-replay
rules_hash: 56b73896cfba
---
# Consumer effects
## Definition
An effect is the change a consumer makes when it applies one event, such as writing a row to a [projection ↗](../sw-external-terms.md#projection). The system promises that each event takes effect once in effect, even when the event is delivered more than once. The consumer's declared [deduplication mode](consumer-deduplication-mode.md) decides how it prevents a second effect. An [`inbox`](inbox-table.md) consumer records [`(consumer, eventId)`](event-id.md) in the same transaction as the effect. A consumer commits its [offsets ↗](../sw-external-terms.md#kafka-offset-commit) only after the effects, so a disconnect leads to redelivery and nothing is lost.

## Example
`OrderBasketsProjector` in [S34](../capabilities/S34-recommendations.md) receives an `order.paid` event, and its effect is to record one basket for that order. If the consumer disconnects before committing the offset, the event is delivered again. The declared deduplication mode then stops a second basket from being recorded.

## Known gaps
- The spec does not say whether the effects of a whole [consumer batch](consumer-batch.md) share one transaction or each event gets its own.
- The spec does not say what happens when an effect fails for a reason other than a schema failure, such as a database error: whether the consumer retries, [dead-letters ↗](../sw-external-terms.md#dead-letter-queue) or stops.
- The spec does not say whether an effect may be something other than a read-model write, such as a call to an external service, or how such an effect would be deduplicated.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-19
- [after-commit-callback](after-commit-callback.md)
- [consumer-batch](consumer-batch.md)
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [partition-pause](partition-pause.md)
<!-- used-by:end -->
