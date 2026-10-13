---
id: aggregate-id
title: aggregateId
kind: term
status: draft
aliases: [aggregate]
defined_for: outbox-task-queue
rules_hash: ee8476e2987b
---
# aggregateId
## Definition
`aggregateId` identifies the domain entity an event belongs to, for example one product or one order. [The relay](outbox-relay.md) uses it as the [Kafka message key ↗](../sw-external-terms.md#kafka-message). Events that share an `aggregateId` keep their order. In this context, "aggregate" means the domain entity, not the [BFF page aggregate](page-aggregate.md).

## Example
[S05](../capabilities/S05-products.md) writes two events for the same product. Both are published with key `aggregateId = "prod_123"` (illustrative). Because they share a key, [consumers](event-consumer.md) see them in the order they were written.

## Known gaps
- The spec does not say which field each domain uses as `aggregateId`, for example the product id or the order id.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-07, R-16, B-01, B-19
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md)
- [aggregate-type](aggregate-type.md)
- [carries-state](carries-state.md)
- [checkpoint-lookup](checkpoint-lookup.md)
- [domain](domain.md)
- [event-backbone](event-backbone.md)
- [event-consumer](event-consumer.md)
- [non-retryable-broker-error](non-retryable-broker-error.md)
- [outbox-relay](outbox-relay.md)
- [page-aggregate](page-aggregate.md)
- [pending-row](pending-row.md)
- [per-aggregate-ordering](per-aggregate-ordering.md)
- [shop-not-found](shop-not-found.md)
- [source-topic](source-topic.md)
- [write-model](write-model.md)
<!-- used-by:end -->
