---
id: products-flush-view-counts-job
title: products.flush-view-counts job
kind: term
status: draft
aliases: [products.flush-view-counts]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# products.flush-view-counts job
## Definition
The `products.flush-view-counts` job is a [scheduled job](job.md) that runs the [view count flush](view-count-flush.md) on a fixed schedule. Each run claims the [pending view counts](view-count-claim.md) and adds them to each product's stored `viewCount`, one [view count chunk](view-count-chunk.md) at a time. Each chunk runs in its own transaction and writes one [`ProductViewBatch` marker](product-view-batch-marker.md). The job changes no [product version](product-version.md), writes no event and deletes no cache entry, so a view never looks like an edit (design intent, not stated in the spec). It is declared in [`ProductMaintenanceJobs`](product-maintenance-jobs.md), next to the purge of old stock operations.

## Example
A product gets five public reads, so it has five pending views. On its next run, `products.flush-view-counts` stores `viewCount: 5`, and the product's `version` does not change. In another case, 2,500 products have pending views and the second chunk fails. The run stores 1,000 of them, the other 1,500 stay pending, and the next run stores those exactly once.

## Known gaps
- The spec does not say where the pending counts are stored. S05.B-11 says a view is not counted when the shared cache is down, which suggests the counts live there. The code does not confirm this.
- The spec does not say which [cron overlap policy](cron-overlap-policy.md) the job uses. It only says that two flushes running at the same time still apply each count once.
- The spec does not say what happens to claimed counts if the worker crashes during a run, for example whether the claim expires and is taken again.

## Used by
<!-- used-by:start -->
- [cron-overlap-policy](cron-overlap-policy.md)
- [job](job.md)
- [product-version](product-version.md)
- [product-view-batch-marker](product-view-batch-marker.md)
- [view-count-chunk](view-count-chunk.md)
- [view-count-claim](view-count-claim.md)
- [view-count-flush](view-count-flush.md)
<!-- used-by:end -->
