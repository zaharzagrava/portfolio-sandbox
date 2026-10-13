---
id: connection-routing
title: Connection routing
kind: term
status: draft
aliases: [routing]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# Connection routing
## Definition
Connection routing sends the work for a shop to the separate part of the system that holds and serves that shop's data. It is [fail-closed ↗](../sw-external-terms.md#fail-open-fail-closed). If that place is unknown, the request fails with [`cell_unavailable`](cell-unavailable.md) and is never sent to a guessed or default place. Design intent (not stated in the spec): failing closed stops a shop's data from being read or written in the wrong place, which protects [tenant isolation](tenant.md).

## Example
A request for shop `shop_123` (illustrative) is routed to its cell `cell-a` (illustrative). Suppose routing does not know the cell recorded for that shop. The request then answers `503 cell_unavailable` and does not fall back to another cell.

## Known gaps
- The spec does not say where routing happens (per request, per database connection or per connection pool), or which component does it.
- The spec does not say how routing finds out a shop's cell, for example whether it calls [`ShopCellService`](shop-cell-service.md).
- The spec does not finish the decision: its text is cut off after "never", so we do not know what the forbidden fallback is.

## Used by
<!-- used-by:start -->
- [cell-unavailable](cell-unavailable.md)
- [shop-cell-service](shop-cell-service.md)
- [shop-cell](shop-cell.md)
- [tenant](tenant.md)
<!-- used-by:end -->
