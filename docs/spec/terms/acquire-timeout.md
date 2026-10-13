---
id: acquire-timeout
title: Acquire timeout
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: ff352f62706c
---
# Acquire timeout
## Definition
The acquire timeout is the longest time a request waits for a free connection from a [cell's connection pool ↗](../sw-external-terms.md#connection-pool). If the pool stays full for that whole time, the request fails with `503 [cell](shop-cell.md)_unavailable`. It does not fall back to the [pooled database](pooled-database.md). Only shops [routed to that cell](connection-routing.md) are affected.

## Example
Every connection to cell `eu-2` (illustrative) is busy. A request for a shop in that cell waits for the acquire timeout, which is 2 s in S03.R-24. If no connection frees up, the answer is [`503 cell_unavailable`](cell-unavailable.md). Requests for shops in other cells continue normally.

## Known gaps
- The spec does not say whether the acquire timeout can be configured, or whether each cell has its own value.
- The spec does not say whether the `503 cell_unavailable` answer includes a [`Retry-After` header ↗](../sw-external-terms.md#retry-after).

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-24
- [connection-routing](connection-routing.md)
- [pooled-database](pooled-database.md)
<!-- used-by:end -->
