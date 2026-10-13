---
id: shop-cell
title: Cell (shop cell)
kind: term
status: draft
aliases: [cells]
defined_for: S03-shops-rbac
rules_hash: 230757c73626
---
# Cell (shop cell)
## Definition
A cell is a shop's place in the infrastructure. [The tenancy capability](tenancy-domain-layer.md) records which cell each shop belongs to. [Connection routing](connection-routing.md) uses the shop's cell to decide where that shop's work goes. Other [capabilities](capability.md) get cell information through [`ShopCellService`](shop-cell-service.md). When a shop moves to another cell, tenancy publishes [`tenancy.shop_cell_moved`](shop-cell-moved-event.md).

## Example
Shop `shop_123` (illustrative) lives in cell `cell-a` (illustrative). A request for `shop_123` is routed to `cell-a`. If the shop moves to `cell-b` (illustrative), tenancy emits `tenancy.shop_cell_moved`, and later requests go to `cell-b`.

## Known gaps
- The spec does not say what a cell physically is (a database, a cluster or a region), or how cells are named and configured.
- Not confirmed in the code: which methods `ShopCellService` exposes, or whether it is the component that moves shops between cells.
- The spec does not say what happens to requests for a shop while it is moving between cells.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-24
- [allowed-region](allowed-region.md)
- [capability](capability.md)
- [connection-routing](connection-routing.md)
- [directory-row-version](directory-row-version.md)
- [directory-row](directory-row.md)
- [directory-version](directory-version.md)
- [platform-admin](platform-admin.md)
- [pooled-database](pooled-database.md)
- [pooled-placement](pooled-placement.md)
- [shop-cell-directory-row](shop-cell-directory-row.md)
- [shop-cell-move](shop-cell-move.md)
- [shop-cell-service](shop-cell-service.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
- [unknown-cell](unknown-cell.md)
<!-- used-by:end -->
