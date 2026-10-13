---
id: consumer-deduplication-mode
title: Consumer deduplication mode
kind: term
status: draft
aliases: [deduplication mode, deduplication modes]
defined_for: outbox-task-queue
rules_hash: 9b4f5f8edd25
---
# Consumer deduplication mode
## Definition
A consumer deduplication mode is the strategy an [event consumer](event-consumer.md) declares for applying each event once in effect. The modes are [`inbox`](inbox-table.md), [`versionGuard`](version-guard.md) and [`natural`](natural-idempotency.md). Every consumer of [outbox events](inbox-table.md) must declare one. The mode matters because [publication is at least once](at-least-once-delivery.md), so the same [`eventId`](event-id.md) can arrive more than once. With any mode, the consumer [commits its offset ↗](../sw-external-terms.md#kafka-offset-commit) only after its effects, so a redelivery never loses an event.

## Example
A consumer of [S05](../capabilities/S05-products.md) product events declares `versionGuard` (the choice of mode is illustrative). [The relay crashes between send and mark](outbox-relay.md), so the same event is published again with the same `eventId`. The declared mode makes the second copy have no further effect. The consumer commits the offset only after that step.

## Known gaps
- The spec does not say how or where a consumer declares its mode, for example a decorator, a config field or a registration call.
- The spec does not say what happens if a consumer declares no mode: whether startup fails, a CI check rejects it, or nothing enforces it.
- The spec does not say how to choose between `inbox`, `versionGuard` and `natural` for a given consumer.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): B-13
- [projection-and-replay](../concepts/projection-and-replay.md): C-05
- [at-least-once-delivery](at-least-once-delivery.md)
- [consumer-effects](consumer-effects.md)
- [consumer-group](consumer-group.md)
- [event-backbone](event-backbone.md)
- [event-consumer](event-consumer.md)
- [inbox-table](inbox-table.md)
- [natural-idempotency](natural-idempotency.md)
- [outbox-relay](outbox-relay.md)
- [payment-processor](payment-processor.md)
- [payments-events-consumer](payments-events-consumer.md)
- [post-search-clicks](post-search-clicks.md)
- [version-guard](version-guard.md)
<!-- used-by:end -->
