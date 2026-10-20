---
id: search-product-index-queue
title: search-product-index queue
kind: term
status: draft
aliases: [search-product-index]
defined_for: J04-catalog-sync-to-search
rules_hash: e3b0c44298fc
---
# search-product-index queue
## Definition
`search-product-index` is the [event consumer](event-consumer.md) that keeps the public search index in step with the catalog. It reads [`catalog.product_*`](catalog-product-events.md) events from the [outbox ↗](../sw-external-terms.md#transactional-outbox) and updates each product's search entry with its price, title, availability and visibility. Like every consumer in this chain, it is [idempotent ↗](../sw-external-terms.md#idempotency) and [version-guarded](version-guard.md), so a replay or an old event leaves search unchanged. It is owned by another [capability](capability.md); journey J04 only observes it.

## Example
A device sells all 4 units of `Ps`. The catalog emits a `catalog.product_*` event. `search-product-index` applies it, and public search changes from `inStock: true` to out of stock. If the consumer is paused, search keeps showing `inStock: true` until it resumes.

## Known gaps
- The spec does not say this is a queue. The facts call it a consumer and name only `catalog-imports` as a queue.
- The spec does not say which capability owns this consumer, or what its consumer group or topic is called.
- The spec does not say how long search may lag behind the catalog. The time bounds (H3, H7 and others) are not defined.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
