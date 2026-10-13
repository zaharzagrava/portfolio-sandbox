---
id: pooled-database
title: Pooled database
kind: term
status: draft
aliases: [default database]
defined_for: S03-shops-rbac
rules_hash: 2d621d176f3f
---
# Pooled database
## Definition
The pooled database is the database a request must never fall back to when it cannot use a shop's [cell](shop-cell.md). Reading the rule, it is the shared default database used by shops that are not placed in a dedicated cell. That reading is inferred from the rule, not defined in the spec. If [routing](connection-routing.md) fails, the request answers [`503 cell_unavailable`](cell-unavailable.md) and does not use this database. Writing a shop's data to the wrong database could split or leak [tenant data](tenant.md). That reason is design intent (not stated in the spec).

## Example
Shop `acme` (illustrative) is moved to cell `eu-2` (illustrative) through [`PUT /admin/shops/:shopId/directory`](shop-cell-move.md). Later, `eu-2` cannot be reached. Requests for `acme` answer `503 cell_unavailable` instead of reading from or writing to the pooled database.

## Known gaps
- The spec does not define the pooled database or say which shops live in it by default.
- The spec does not say whether the [tenant setting rules](tenant-setting.md) of S03.R-19 apply the same way in the pooled database and in dedicated cells.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-24
- [acquire-timeout](acquire-timeout.md)
- [connection-routing](connection-routing.md)
- [directory-row](directory-row.md)
- [pooled-placement](pooled-placement.md)
- [shop-cell](shop-cell.md)
- [tenant-setting](tenant-setting.md)
- [tenant](tenant.md)
<!-- used-by:end -->
