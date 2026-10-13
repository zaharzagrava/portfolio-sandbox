---
id: directory-row
title: Directory row
kind: term
status: draft
aliases: [shop directory]
defined_for: S03-shops-rbac
rules_hash: 3723a747f76e
---
# Directory row
## Definition
The directory row records which [database cell](shop-cell.md) a shop is routed to. The [connection resolver](connection-routing.md) uses it to route the shop's requests, and `ShopCellService` reads it, with an [in-process cache](l1-cache.md). [Platform admins](platform-admin.md) read and change it through `GET|PUT /admin/shops/:shopId/directory`. A change is [conditional on the row's version](directory-row-version.md), and the cache entry is dropped when the shop moves. The purge deletes the row.

## Example
An admin with a [session that is not revoked](session-revocation.md) sends `PUT /admin/shops/:shopId/directory` with a target cell and the version they last read. If someone moved the shop in between, the answer is `[409 stale_version](stale-version.md)`. If the cell is not configured, the answer is `[422 unknown_cell](unknown-cell.md)`.

## Known gaps
- The spec does not say how a shop with no directory row is routed, for example whether it uses the [pooled database](pooled-database.md).
- The spec does not list the row's columns beyond the cell and the version.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-27
- [connection-routing](connection-routing.md)
- [directory-row-version](directory-row-version.md)
- [directory-version](directory-version.md)
- [l1-cache](l1-cache.md)
- [platform-admin](platform-admin.md)
- [pooled-database](pooled-database.md)
- [pooled-placement](pooled-placement.md)
- [session-revocation](session-revocation.md)
- [shop-cell](shop-cell.md)
- [shop-purge](shop-purge.md)
- [shop-tombstone](shop-tombstone.md)
<!-- used-by:end -->
