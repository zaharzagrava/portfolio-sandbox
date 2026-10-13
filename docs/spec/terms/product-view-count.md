---
id: product-view-count
title: Product view count
kind: term
status: draft
aliases: [view, view counted, viewcount]
defined_for: S05-products
rules_hash: 065a8112990b
---
# Product view count
## Definition
The product view count is an approximate count of how often a product page has been read. Reads add to a counter in the [shared cache](l2-cache.md), so they never wait on the database. The scheduled job [`products.flush-view-counts`](view-count-flush.md) copies the counts into the stored `viewCount` without changing the [product version](product-version.md). If the shared cache is down, the read still works, but that view is not counted.

## Example
A product is read five times and then the flush job runs. The stored `viewCount` is now 5, and `version` is unchanged.

## Known gaps
- The spec does not say which reads count. For example, it does not say whether [member views](member-view.md), [`304` answers ↗](../sw-external-terms.md#http-304-not-modified) or [batch reads](batch-shops-lookup.md) count. No test covers the "not counted" cases (AS-73 to AS-75).
- The spec does not say whether counts survive a failed flush or two workers flushing at once. No test covers these cases (AS-67 to AS-79).
- Not confirmed in the code: what the `ProductViewBatch` table holds and how the job uses it.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): B-11
- [S35](../capabilities/S35-trending.md): R-18, B-07
- [batch-shops-lookup](batch-shops-lookup.md)
- [l2-cache](l2-cache.md)
- [member-view](member-view.md)
- [product-version](product-version.md)
<!-- used-by:end -->
