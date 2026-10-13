---
id: product-view-batch-marker
title: ProductViewBatch marker
kind: term
status: draft
aliases: [productviewbatch]
defined_for: S05-products
rules_hash: 0bd9832e02c5
---
# ProductViewBatch marker
## Definition
A `ProductViewBatch` marker is a row in the `ProductViewBatch` table, which the catalog owns. [The view count flush](view-count-flush.md) writes one marker for each [chunk](view-count-chunk.md) of products it applies. The marker is written [in the same transaction ↗](../sw-external-terms.md#database-transaction) as that chunk's view count updates, so both commit together or neither does. Design intent (not stated in the spec): the marker records that a chunk is already applied, which would explain how [two concurrent flushes](concurrent-flush.md) still apply each count only once.

## Example
The `products.flush-view-counts` job [claims pending counts](view-count-claim.md) for 2,500 products. It applies them in three chunks: 1,000, 1,000 and 500 products. Each chunk runs in its own transaction and writes its own `ProductViewBatch` row, so the flush leaves three markers.

## Known gaps
- The spec does not say which columns a marker holds, such as a batch ID, the product IDs or a timestamp.
- The spec does not say whether markers are ever purged. Only stock operations older than 30 days are named as purged.
- Not confirmed in the code: the marker is what blocks double application between concurrent flushes. The rule gives only the outcome, "each count once".

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-21
- [concurrent-flush](concurrent-flush.md)
- [products-flush-view-counts-job](products-flush-view-counts-job.md)
- [view-count-chunk](view-count-chunk.md)
- [view-count-claim](view-count-claim.md)
- [view-count-flush](view-count-flush.md)
<!-- used-by:end -->
