---
id: directory-row-version
title: Directory row version
kind: term
status: draft
aliases: [version]
defined_for: S03-shops-rbac
rules_hash: ea1aca0f6e76
---
# Directory row version
## Definition
Each shop has a directory row that records where the shop lives: its [cell](shop-cell.md) and its [region](allowed-region.md). The directory row version is a counter on that row. A [shop cell move](shop-cell-move.md) must say which version it expects. If the row has changed since then, the move is refused with [`409 stale_version`](stale-version.md) and nothing changes. This keeps two administrators from overwriting each other's moves without noticing ([optimistic concurrency](optimistic-concurrency.md)).

## Example
A new shop's directory row starts as `pooled` at version 1. An administrator reads it with `GET /admin/shops/:shopId/directory` and sends a `PUT` that expects version 1. Before that request lands, another administrator moves the same shop. The first `PUT` now answers `409 stale_version`.

## Known gaps
- The spec does not say how the version changes after a successful move, for example whether it goes up by one.
- The spec does not say how the expected version is sent in the `PUT` request, for example as a body field or as a header.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-28
- [allowed-region](allowed-region.md)
- [directory-row](directory-row.md)
- [optimistic-concurrency](optimistic-concurrency.md)
- [shop-cell-directory-row](shop-cell-directory-row.md)
- [shop-cell-move](shop-cell-move.md)
- [shop-cell](shop-cell.md)
<!-- used-by:end -->
