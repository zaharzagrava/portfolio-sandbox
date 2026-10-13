---
id: consumer-group
title: Consumer group
kind: term
status: draft
aliases: [group name, group names]
defined_for: projection-and-replay
rules_hash: 0b138197e82d
---
# Consumer group
## Definition
A consumer group is the name a consumer declares when it registers to read the event log. Every consumer must also declare a [consumer deduplication mode](consumer-deduplication-mode.md): [`inbox`](inbox-table.md), [`versionGuard`](version-guard.md) or [`natural`](natural-idempotency.md). Group names must be unique. If two consumers declare the same name, startup fails with [`ConsumerDeclarationError`](consumer-declaration-error.md). The group is the identity under which a consumer reads and commits its [offsets ↗](../sw-external-terms.md#kafka-offset-commit); this is how Kafka consumer groups generally work, not something the spec states.

## Example
`OrderBasketsProjector` reads `order.paid` events under its own group, for example `order-baskets` (illustrative name). If a second consumer also declared `order-baskets`, the service would refuse to start.

## Known gaps
- The spec does not say whether names must be unique within one service or across the whole fleet.
- The spec does not say whether the `consumer` value in an `inbox` record `(consumer, eventId)` is the group name.
- The spec does not give a naming convention for groups.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-17
- [projection-and-replay](../concepts/projection-and-replay.md): C-03
- [analytics-events-topic](analytics-events-topic.md)
- [consumer-declaration-error](consumer-declaration-error.md)
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [dead-letter-redrive](dead-letter-redrive.md)
<!-- used-by:end -->
