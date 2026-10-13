---
id: unknown-cell
title: unknown_cell (422)
kind: term
status: draft
aliases: [unknown_cell]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# unknown_cell (422)
## Definition
`unknown_cell` is the `422` error a move between [cells](shop-cell.md) returns when the target is not a [configured shop cell](shop-cell.md). The request is checked before anything is stored, so the shop stays in its current cell. It differs from [`cell_unavailable`](cell-unavailable.md): that error is returned at [routing time](connection-routing.md), when a configured cell cannot be reached.

## Example
A [platform admin](platform-admin.md) sends [`PUT /admin/shops/:shopId/directory`](shop-cell-move.md) with the target cell `eu-9` (illustrative name). No such cell is configured, so the answer is `422 unknown_cell`.

## Known gaps
- The spec does not say where cells are configured or how to list the valid cell names.
- The spec does not say which check runs first when a request has both a [stale version](stale-version.md) and an unknown cell.

## Used by
<!-- used-by:start -->
- [connection-routing](connection-routing.md)
- [platform-admin](platform-admin.md)
- [shop-cell](shop-cell.md)
- [stale-version](stale-version.md)
<!-- used-by:end -->
