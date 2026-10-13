---
id: view-count-flush
title: View count flush
kind: term
status: draft
aliases: [flush, view flush]
defined_for: S05-products
rules_hash: dc6e41f3c2fe
---
# View count flush
## Definition
The view count flush is the scheduled job `products.flush-view-counts`. It moves approximate view counts from the [shared cache](l2-cache.md) into the stored [`viewCount`](product-view-count.md) of each product. This lets reads count views without waiting on the database. The flush does not increase the product [`version`](product-version.md). That keeps view traffic from causing [`version_conflict`](version-conflict.md) for members who are editing the product: design intent (not stated in the spec). When the shared cache is down, reads are not counted at all.

## Example
A product at `version: 3` (illustrative) is read five times, then the flush runs. The stored `viewCount` becomes 5 and `version` is still 3.

## Known gaps
- The spec does not say how the flush handles failures, chunking, two workers running at once, or [suspended and purged shops](shop-status.md). The spec lists these cases (AS-67 to AS-79), but no test covers them, so the behaviour is not verified.
- The spec does not say whether a flush writes a product event or deletes the cache entry. The "no write amplification" case (AS-74) has no test.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): B-17
- [l2-cache](l2-cache.md)
- [shop-status](shop-status.md)
<!-- used-by:end -->
