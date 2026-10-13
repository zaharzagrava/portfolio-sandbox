---
id: natural-idempotency
title: natural idempotency
kind: term
status: draft
aliases: [natural]
defined_for: outbox-task-queue
rules_hash: a697a1a047ab
---
# natural idempotency
## Definition
`natural` is one of the three [deduplication modes](consumer-deduplication-mode.md) a [Kafka consumer](event-consumer.md) of [outbox events](inbox-table.md) must declare. It means the consumer's effect is already [idempotent ↗](../sw-external-terms.md#idempotency) through a natural key, so applying the same event twice leaves the same result. The consumer needs no [inbox table](inbox-table.md) and no [version check](version-guard.md). Like every consumer, it commits its [offset ↗](../sw-external-terms.md#kafka-offset-commit) only after its effects are done.

## Example
Here is an illustrative consumer. It handles an order-status event by [upserting ↗](../sw-external-terms.md#upsert) `status = "paid"` on the row keyed by `orderId`. If the same `[eventId](event-id.md)` is delivered twice, the second upsert writes the same value and changes nothing.

## Known gaps
- The spec does not say which consumers declare `natural`, or how a reviewer checks that an effect really is idempotent.
- The spec does not say whether the CI check or any runtime check verifies the declared mode.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): B-17
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [event-consumer](event-consumer.md)
- [inbox-table](inbox-table.md)
- [version-guard](version-guard.md)
<!-- used-by:end -->
