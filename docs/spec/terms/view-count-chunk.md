---
id: view-count-chunk
title: View count chunk
kind: term
status: draft
aliases: [chunks]
defined_for: S05-products
rules_hash: eb6e2f18227d
---
# View count chunk
## Definition
A view count chunk is one slice of the [pending counts](view-count-claim.md) that a [view count flush](view-count-flush.md) has claimed. The flush applies each chunk in its own [transaction ↗](../sw-external-terms.md#database-transaction) and writes one `ProductViewBatch` marker for it. Applying a chunk changes no product [`version`](product-version.md), writes no event and deletes no [cache entry](cache-entry.md). If one chunk fails, the flush stops. Chunks already applied stay applied, and the chunks not yet applied go back to the pending counts.

## Example
A flush claims pending views for 2,500 products and splits them into chunks of 1,000, 1,000 and 500. The second chunk fails. The first 1,000 products keep their new `viewCount`. The other 1,500 go back to pending, and the next flush stores them once.

## Known gaps
- The spec does not say how products are assigned to chunks, for example whether they are sorted by product ID.
- The spec does not say whether a failed chunk is retried within the same flush. The rule only says the flush stops and the next flush stores the rest.

## Used by
<!-- used-by:start -->
- [cache-entry](cache-entry.md)
- [pending-count-member](pending-count-member.md)
- [product-view-batch-marker](product-view-batch-marker.md)
- [products-flush-view-counts-job](products-flush-view-counts-job.md)
- [view-count-claim](view-count-claim.md)
- [view-count-flush](view-count-flush.md)
<!-- used-by:end -->
