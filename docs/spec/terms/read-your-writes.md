---
id: read-your-writes
title: Read-your-writes
kind: term
status: draft
aliases: [read your writes]
defined_for: outbox-task-queue
rules_hash: bcb17fdb7b61
---
# Read-your-writes
## Definition
Read-your-writes is a guarantee that [S53](../capabilities/S53-events-projections.md) is said to define, but the spec gives no rule for it. In general engineering, it means a caller who just wrote something sees that write in their next read. On the [event backbone](event-backbone.md) this matters because [consumers](event-consumer.md) update their state after the write commits, so their view can lag. How S53 provides the guarantee is not described.

## Example
Illustrative, not taken from the spec: a shop owner renames a product in [S05](../capabilities/S05-products.md), then searches for it right away. [S32's index](../capabilities/S32-product-search.md) changes only when the product event arrives. Read-your-writes would make sure the owner sees the new name, not the old one.

## Known gaps
- The spec does not say how read-your-writes is provided, for example by waiting for a consumer to catch up or by reading from the source domain.
- The spec does not say which reads or capabilities get the guarantee.
- The spec does not say what a caller sees if the guarantee cannot be met in time.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): B-06
- [checkpoint-lookup](checkpoint-lookup.md)
- [event-backbone](event-backbone.md)
- [event-consumer](event-consumer.md)
- [min-version](min-version.md)
- [pending-read-mode](pending-read-mode.md)
- [read-model](read-model.md)
- [read-wait-timeout](read-wait-timeout.md)
- [write-model](write-model.md)
- [x-read-source-header](x-read-source-header.md)
<!-- used-by:end -->
