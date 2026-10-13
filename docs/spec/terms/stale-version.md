---
id: stale-version
title: stale_version (409)
kind: term
status: draft
aliases: [stale_version]
defined_for: S03-shops-rbac
rules_hash: 6910f5a01eb9
---
# stale_version (409)
## Definition
`stale_version` is the `409` error a move between cells returns when the directory version in the request is not the stored one. It means someone changed the shop's directory row after the caller read it. Nothing is changed. The caller should read the directory again and decide whether to retry the move. Design intent (not stated in the spec): it prevents lost updates without locking the row.

## Example
```
PUT /admin/shops/:shopId/directory   (carries version 7, illustrative; stored version is 8)
→ 409 { "code": "stale_version", ... }
```

## Known gaps
- The spec does not say whether the error body includes the current version.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-07
- [unknown-cell](unknown-cell.md)
<!-- used-by:end -->
