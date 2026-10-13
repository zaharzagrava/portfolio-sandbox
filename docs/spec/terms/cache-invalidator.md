---
id: cache-invalidator
title: Cache invalidator
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# Cache invalidator
## Definition
The cache invalidator (`ProductCacheInvalidator`) is the [event consumer](event-consumer.md) of [`products.events`](products-events-topic.md) that deletes product [cache entries](cache-entry.md). A write already [deletes its entry after commit](invalidation-only-writes.md). The invalidator is the backup that repairs a delete that was lost. It deletes an entry only when the event's version is higher than the version stored in that entry. [Stale or duplicate events](consumer-outcomes.md) change nothing, so a late event cannot remove fresher data. Like every writer, it only deletes and never stores a value.

## Example
The cached entry for a product holds version 4. [`catalog.product_updated`](catalog-product-updated-event.md) arrives with version 5, so the invalidator deletes the entry, and the next read loads the product from the database. Later, a delayed event with version 4 arrives and is ignored. (Version numbers are illustrative.)
Code: `packages/backend/libs/domains/catalog/infra/product-cache-invalidator.projector.ts#ProductCacheInvalidator`

## Known gaps
- The spec does not say whether the invalidator clears both the [L1 cache](l1-cache.md) in every process and the [L2 cache](l2-cache.md), or only the L2 cache.
- The spec does not say what the invalidator does when no cache entry exists or the shared cache is down.
- Not confirmed in the code: the tests for [AS-40](acceptance-scenario.md) and AS-44 to AS-47 live only in the invalidation test file, and the facts do not show what they check.

## Used by
<!-- used-by:start -->
- [acceptance-scenario](acceptance-scenario.md)
- [cache-entry](cache-entry.md)
- [catalog-product-deleted-event](catalog-product-deleted-event.md)
- [consumer-outcomes](consumer-outcomes.md)
- [event-consumer](event-consumer.md)
- [invalidation-only-writes](invalidation-only-writes.md)
- [l1-cache](l1-cache.md)
- [l2-cache](l2-cache.md)
- [products-events-topic](products-events-topic.md)
<!-- used-by:end -->
