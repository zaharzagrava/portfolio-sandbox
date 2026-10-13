---
id: pooled-placement
title: pooled placement
kind: term
status: draft
aliases: [pooled]
defined_for: S03-shops-rbac
rules_hash: c1d928d649dd
---
# pooled placement
## Definition
`pooled` is the placement value in a [directory row](directory-row.md) for a shop whose data is in the shared [pooled database](pooled-database.md), not in a [dedicated cell](shop-cell.md). Every new shop starts as `pooled`. [Routing must fail closed](connection-routing.md): if a shop is placed in a cell and that cell is unavailable, the request answers `[503 cell_unavailable](cell-unavailable.md)`. It never falls back to the pooled database. Design intent (not stated in the spec): falling back could put one shop's writes in the wrong store.

## Example
`POST /shops` creates a shop whose directory row has placement `pooled` and version `1`. Its requests then use the pooled database until an admin moves it with `[PUT /admin/shops/:shopId/directory](shop-cell-move.md)`.

## Known gaps
- The spec does not name the placement value for shops that live in a dedicated cell.
- The spec does not say whether an admin can move a shop from a cell back to `pooled`.

## Used by
<!-- used-by:start -->
- [connection-routing](connection-routing.md)
- [directory-row](directory-row.md)
- [pooled-database](pooled-database.md)
- [shop-cell-directory-row](shop-cell-directory-row.md)
- [shop-cell](shop-cell.md)
<!-- used-by:end -->
