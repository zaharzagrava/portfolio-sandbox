---
id: shop-cell-directory-row
title: Shop directory row
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: f0f2ba1bbc5f
---
# Shop directory row
## Definition
The shop directory row is a shop's record of where its data lives: its [placement](pooled-placement.md), its [region](allowed-region.md) and its [version](directory-row-version.md). [Connection routing](connection-routing.md) reads it to choose the database for the shop's requests. It is created together with the shop, and only a [platform administrator](platform-admin.md) can change it, through `PUT /admin/shops/:shopId/directory`. A change must match the current version (otherwise [`409 stale_version`](stale-version.md)) and must name a configured [cell](shop-cell.md) (otherwise [`422 unknown_cell`](unknown-cell.md)). Each process caches the lookup for a short time and drops the cached value when the shop moves.

## Example
A new shop gets a directory row with placement `pooled` and version `1`, in the default region or a requested allowed region. When an admin later moves the shop to a cell, the request must send version `1`. If another move happened first, the request gets `409 stale_version`.

## Known gaps
- The spec does not list the fields of the row beyond placement, region and version, and it does not show the response shape of `GET /admin/shops/:shopId/directory`.
- The spec does not say whether the move publishes [`tenancy.shop_cell_moved`](shop-cell-moved-event.md), or when it does. That event has its own page, but the facts here do not connect it to the move.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-28
- [allowed-region](allowed-region.md)
- [connection-routing](connection-routing.md)
- [directory-row-version](directory-row-version.md)
- [platform-admin](platform-admin.md)
- [pooled-placement](pooled-placement.md)
- [shop-cell](shop-cell.md)
- [shop-purge-job](shop-purge-job.md)
<!-- used-by:end -->
