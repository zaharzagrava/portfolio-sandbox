---
id: view-count-claim
title: Pending view count claim
kind: term
status: draft
aliases: [claims, pending counts]
defined_for: S05-products
rules_hash: 101d9b474a81
---
# Pending view count claim
## Definition
The claim is the first step of a [view count flush](view-count-flush.md). It takes the current pending counts so that this flush run owns them. Views recorded after the claim build up as new pending counts for the next flush. If a chunk fails, the counts in the chunks not yet applied go back to the pending counts, so no views are lost. Pending count members that are not [UUIDs ↗](../sw-external-terms.md#uuid) are skipped and counted, not applied.

## Example
Five public reads of a product leave five pending views. The [`products.flush-view-counts` job](products-flush-view-counts-job.md) claims them and applies them. The stored `viewCount` becomes 5 and the product's `version` does not change.

## Known gaps
- The spec does not say where the pending counts are stored. Behavior S05.B-11 says a view is not counted when the shared cache is down, which suggests they live there, but this is not confirmed in the code.
- The spec does not say what happens to claimed counts if the worker crashes during a flush, for example whether a claim expires and is reclaimed.
- The spec does not say where the number of skipped non-UUID members is recorded, such as a metric or a log.

## Used by
<!-- used-by:start -->
- [application-layer](application-layer.md)
- [concurrent-flush](concurrent-flush.md)
- [pending-count-member](pending-count-member.md)
- [product-view-batch-marker](product-view-batch-marker.md)
- [products-flush-view-counts-job](products-flush-view-counts-job.md)
- [view-count-chunk](view-count-chunk.md)
- [view-count-flush](view-count-flush.md)
<!-- used-by:end -->
