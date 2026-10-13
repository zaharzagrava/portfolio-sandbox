---
id: shop-cell-moved-event
title: tenancy.shop_cell_moved event
kind: term
status: draft
aliases: [tenancy.shop_cell_moved]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# tenancy.shop_cell_moved event
## Definition
`tenancy.shop_[cell](shop-cell.md)_moved` is an event that the [tenancy capability](tenancy-domain-layer.md) publishes when a shop moves to another cell. Like every tenancy event, it commits in the [same transaction](transaction-scope.md) as the state change. If the [outbox append](outbox-append.md) fails, the move is rolled back. Design intent (not stated in the spec): other capabilities can listen for it to learn that a shop's location has changed.

## Example
Shop `shop_123` (illustrative) moves from `cell-a` to `cell-b` (both illustrative). In one transaction, tenancy records the new cell and appends `tenancy.shop_cell_moved` to the outbox. If that append fails, the shop stays in `cell-a` and no event is published.

## Known gaps
- The spec does not say what the event payload contains (for example the old cell, the new cell or a version).
- The spec does not say which capabilities consume this event.
- Not confirmed in the code: what triggers a cell move, or whether [`ShopCellService`](shop-cell-service.md) performs it.

## Used by
<!-- used-by:start -->
- [outbox-append](outbox-append.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
- [transaction-scope](transaction-scope.md)
<!-- used-by:end -->
