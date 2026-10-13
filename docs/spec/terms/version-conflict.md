---
id: version-conflict
title: version_conflict (409)
kind: term
status: draft
aliases: [currentversion, version_conflict]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# version_conflict (409)
## Definition
`version_conflict` is the error code of a [`409` conflict](conflict-error.md). The server returns it when the [`expectedVersion`](expected-version.md) of an update, [archive or restore](product-archive.md) does not match the [stored product version](product-version.md). The response carries [`currentVersion`](product-version.md), so the client can read the product again and retry. When this error is returned, nothing changes: no row, no event and no [cache invalidation](invalidate.md).

## Example
A client sends `expectedVersion: 3`, but another member already moved the product to version 4 (illustrative values):
```json
{ "code": "version_conflict", "currentVersion": 4 }
```

## Known gaps
- The spec does not say which error wins when a request has a stale version and also targets an archived product. Both `version_conflict` and `product_archived` could apply to such a request.
- The spec does not list the other members of the problem body beyond `currentVersion`.

## Used by
<!-- used-by:start -->
- [conflict-error](conflict-error.md)
- [invalidate](invalidate.md)
- [product-archive](product-archive.md)
- [product-version](product-version.md)
<!-- used-by:end -->
