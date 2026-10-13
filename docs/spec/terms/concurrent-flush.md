---
id: concurrent-flush
title: Concurrent flush
kind: term
status: draft
aliases: [concurrent flushes]
defined_for: S05-products
rules_hash: 65a5f5f4256e
---
# Concurrent flush
## Definition
A concurrent flush happens when two runs of the [view count flush](view-count-flush.md) overlap. The rule says each [pending count](view-count-claim.md) is still applied exactly once, so overlapping runs never double a product's [`viewCount`](product-view-count.md). Design intent (not stated in the spec): overlap can happen because the job runs on a short schedule, so a slow run may still be working when the next one starts.

## Example
Five reads of one product leave five pending views. Two `products.flush-view-counts` runs start at the same moment. Afterwards the stored `viewCount` has gone up by 5, not 10, and [`version`](product-version.md) is unchanged.

## Known gaps
- Not confirmed in the code: how the system prevents double application. The claim step, the `ProductViewBatch` marker, a job lock or a combination of these could each do it. The rule gives only the outcome.
- The spec does not say which cron overlap policy the `products.flush-view-counts` job uses.

## Used by
<!-- used-by:start -->
- [product-view-batch-marker](product-view-batch-marker.md)
- [view-count-claim](view-count-claim.md)
- [view-count-flush](view-count-flush.md)
<!-- used-by:end -->
