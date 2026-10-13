---
id: shop-cell-move
title: Shop cell move
kind: term
status: draft
aliases: [administrator's move, move]
defined_for: S03-shops-rbac
rules_hash: ddcd75f4f417
---
# Shop cell move
## Definition
A shop cell move is how a platform administrator changes which [database cell](shop-cell.md) a shop is [routed](connection-routing.md) to, and which region it is in. It is done with `PUT /admin/shops/:shopId/directory`. Only a [platform `ADMIN`](platform-admin.md) with a [sensitive session](sensitive-route.md) that has not been revoked may do it. The move only succeeds if the request expects the current directory row version (otherwise `[409 stale_version](stale-version.md)`) and names a cell that is configured (otherwise `[422 unknown_cell](unknown-cell.md)`). After a successful move, the process drops its cached cell lookup for that shop, so the next request is routed to the new cell.

## Example
```
PUT /admin/shops/:shopId/directory
→ 409 stale_version   (the expected version is not the current one)
→ 422 unknown_cell    (the named cell is not configured)
```
A shop created as `pooled` at version 1 stays there until such a move.

## Known gaps
- The spec does not say whether the move copies the shop's data to the new cell, or only changes where requests are routed.
- Not confirmed in the code: whether a successful move publishes [`tenancy.shop_cell_moved`](shop-cell-moved-event.md), and whether that event makes other processes drop their cached lookup. The spec only says the cache is dropped "on a move". Without the event, other processes could keep routing to the old cell until their cache expires.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-28
- [allowed-region](allowed-region.md)
- [connection-routing](connection-routing.md)
- [directory-row-version](directory-row-version.md)
- [platform-admin](platform-admin.md)
- [sensitive-route](sensitive-route.md)
- [shop-cell](shop-cell.md)
<!-- used-by:end -->
