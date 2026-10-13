---
id: stock-operation-purge
title: Stock operation purge
kind: term
status: draft
aliases: [purge, stock-operation purge]
defined_for: S05-products
rules_hash: 8fcbee111a39
---
# Stock operation purge
## Definition
The stock operation purge is a [scheduled catalog job](job.md). It deletes [`ProductStockOperation`](stock-operation.md) records once they are older than the [retention period](bounded-retention.md). These records are what make [`applyStockDelta`](apply-stock-delta.md) [idempotent ↗](../sw-external-terms.md#idempotency) by [`operationId`](stock-operation-id.md), so the purge limits how long a replay is recognised. It is declared in `ProductMaintenanceJobs`, and no request or event starts it. It keeps the operations table from growing forever; this is design intent (not stated in the spec).

## Example
A `ProductStockOperation` row was written 31 days ago when `applyStockDelta` ran with `operationId: "op-123"` (illustrative). On its next run the purge job deletes that row (S05.B-18, AS-65).

## Known gaps
- The spec does not give the job's name, its schedule or its cron overlap policy. It only gives the retention period.
- The spec does not say what happens when `applyStockDelta` is called again with an `operationId` that has already been purged. That call might be applied a second time instead of returning `replayed: true`.
- The spec does not say whether the purge deletes in bounded batches or in one statement.

## Used by
<!-- used-by:start -->
- [bounded-retention](bounded-retention.md)
- [job](job.md)
- [product-maintenance-jobs](product-maintenance-jobs.md)
<!-- used-by:end -->
