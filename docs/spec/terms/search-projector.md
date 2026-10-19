---
id: search-projector
title: Search projector
kind: term
status: draft
aliases: [projector]
defined_for: S32-product-search
rules_hash: bbe7cb5e9ac2
---
# Search projector
## Definition
The search projector is the [event consumer](event-consumer.md) that builds the [search index](search-index.md) from catalog, tenancy, marketing and media events. It never reads the catalog's table. It applies a product event when the event's version is at least the [stored version](product-version.md), and [ignores and counts it](consumer-outcomes.md) when the version is lower. It hides products that must not be visible, such as deleted, [sandbox](sandbox-product.md) and suspended-shop products. It [dead-letters](dead-letter-topic.md) invalid or [unsupported-version](unsupported-version.md) messages without changing the index.

## Example
A `catalog.product_updated` event arrives with version 7 for a product whose stored version is 5 (illustrative values). The projector updates that product's [search document](search-document.md). A late event with version 4 for the same product is then ignored and counted, and the document does not change.

## Known gaps
- The spec does not say whether one projector handles every event family (`catalog.product_*`, `tenancy.shop_*`, `marketing.product_sponsorship_changed`, `media.gallery_changed`) or whether each family has its own consumer.
- The spec does not say how the projector writes while a [reindex run](zero-downtime-reindexing.md) is active. For example, it does not say whether it writes to both the [live index](live-index-alias.md) and the new index. The [`catching_up`](reindex-run-status.md) run status suggests a replay step, but its mechanics are not described.
- The spec does not name the counter that records ignored lower-version events.

## Used by
<!-- used-by:start -->
- [balance-version](balance-version.md)
- [consumer-outcomes](consumer-outcomes.md)
- [dead-letter-topic](dead-letter-topic.md)
- [event-consumer](event-consumer.md)
- [get-product-by-id](get-product-by-id.md)
- [in-memory-mailbox](in-memory-mailbox.md)
- [ledger-lag-metric](ledger-lag-metric.md)
- [live-index-alias](live-index-alias.md)
- [price-only-update](price-only-update.md)
- [product-version](product-version.md)
- [sandbox-product](sandbox-product.md)
- [search-document](search-document.md)
- [search-index](search-index.md)
- [search-purge-tombstones-job](search-purge-tombstones-job.md)
- [unsupported-version](unsupported-version.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
