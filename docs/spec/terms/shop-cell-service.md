---
id: shop-cell-service
title: ShopCellService
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: 22f6a4c11e6e
---
# ShopCellService
## Definition
`ShopCellService` is one of the services that the tenancy capability (S03) exports for other capabilities to use. A [cell](shop-cell.md) is the shop's place in the infrastructure. [Connection routing](connection-routing.md) uses a shop's cell to decide where its data lives. Its name suggests the service tells callers which cell a shop is in, and perhaps moves shops between cells. Routing is [fail-closed ↗](../sw-external-terms.md#fail-open-fail-closed): an unknown cell answers [`503 cell_unavailable`](cell-unavailable.md) and is never guessed.

## Example
Possible use (the facts do not link these steps to this service): a shop is moved to another cell, and tenancy emits [`tenancy.shop_cell_moved`](shop-cell-moved-event.md) in the same transaction as the change. A later request routed to a cell that routing does not know answers `503 cell_unavailable`.

## Known gaps
- Not confirmed in the code: which methods `ShopCellService` exposes, or whether it performs the move that emits `tenancy.shop_cell_moved`.
- The spec does not say how cells are named or configured, or what happens to requests for a shop while it is being moved.
- The spec does not say whether other capabilities must ask this service for the cell before opening a database connection for a shop.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-25
- [connection-routing](connection-routing.md)
- [shop-cell](shop-cell.md)
<!-- used-by:end -->
