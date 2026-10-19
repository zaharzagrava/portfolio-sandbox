---
id: catalog-stock
title: Catalog stock
kind: term
status: draft
aliases: [product stock]
defined_for: J03-launch-day
rules_hash: 1ed4cbe92597
---
# Catalog stock
## Definition
Catalog stock is the product's stock count as the catalog holds it. A [drop](drop.md) takes its [units](auction-unit.md) out of this stock and later gives the unsold ones back. Scheduling a drop does not touch it. [Loading](drop-load.md) lowers it exactly once, and end and reconcile raise it again by the unsold units, once.

## Example
From J03.B-11: after a drop is scheduled, the product's catalog stock falls below the drop's units. When `flash-sale.load` runs, the load fails, catalog stock stays untouched, and the sale ends as `START_FAILED(insufficient_stock)` (J03.R-09).

## Known gaps
- The spec does not say whether a catalog stock command or a direct write performs the change, or which domain owns the stock.
- The spec does not say whether units released by `orders.expire-reservation` go back to catalog stock or stay in the drop.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
