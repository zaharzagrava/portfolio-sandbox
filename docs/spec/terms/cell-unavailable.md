---
id: cell-unavailable
title: cell_unavailable (503)
kind: term
status: draft
aliases: [cell_unavailable]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# cell_unavailable (503)
## Definition
`[cell](shop-cell.md)_unavailable` is the [error code](error-code.md) returned when [connection routing](connection-routing.md) does not know the cell a shop's work should go to. The request fails rather than being routed somewhere guessed. Its status is `503`, which means the problem is on the server side and not caused by the caller's input.

## Example
```http
HTTP/1.1 503 Service Unavailable

{ "code": "cell_unavailable" }
```
Other [problem body members](exact-body-members.md) are left out here.

## Known gaps
- The spec does not say whether this answer carries [`Retry-After` ↗](../sw-external-terms.md#retry-after), or whether a client should retry it.
- The spec does not say what makes a cell "unknown" (for example a missing configuration, a shop in the middle of a move, or a cell that is down).

## Used by
<!-- used-by:start -->
- [connection-routing](connection-routing.md)
- [error-code](error-code.md)
- [exact-body-members](exact-body-members.md)
<!-- used-by:end -->
