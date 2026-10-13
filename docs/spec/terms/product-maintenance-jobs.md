---
id: product-maintenance-jobs
title: ProductMaintenanceJobs
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# ProductMaintenanceJobs
## Definition
`ProductMaintenanceJobs` is the place in the catalog's [infra layer](infrastructure-layer.md) where the scheduled jobs for products are declared. It holds two jobs: the [`products.flush-view-counts`](products-flush-view-counts-job.md) job and the [purge of old stock operations](stock-operation-purge.md). Both jobs run on a schedule. No HTTP request or event starts them. The two jobs share one class because both do background upkeep on catalog-owned tables. That reason is design intent (not stated in the spec).

## Example
- `products.flush-view-counts` runs every 10 s. A product with five pending views ends up with `viewCount: 5`, and its [`version`](product-version.md) does not change.
- The stock-operation purge deletes any [`ProductStockOperation`](stock-operation.md) record older than 30 days.

## Known gaps
- The spec does not name the stock-operation purge job or say how often it runs. It only gives the retention period.
- The spec does not say which [cron overlap policy](cron-overlap-policy.md) either job uses. For the flush, it only says that two flushes running at once apply each count once.
- The spec does not say what happens when [`applyStockDelta`](apply-stock-delta.md) is called again with an [`operationId`](stock-operation-id.md) whose record the purge already deleted. The [replay protection](stock-operation-replayed.md) may no longer cover that call.

## Used by
<!-- used-by:start -->
- [cron-overlap-policy](cron-overlap-policy.md)
- [infrastructure-layer](infrastructure-layer.md)
- [stock-operation-purge](stock-operation-purge.md)
- [stock-operation-replayed](stock-operation-replayed.md)
<!-- used-by:end -->
