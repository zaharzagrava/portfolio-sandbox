---
id: directory-version
title: Directory version
kind: term
status: draft
aliases: [shop directory]
defined_for: S03-shops-rbac
rules_hash: 22f6a4c11e6e
---
# Directory version
## Definition
The directory version is a version number on a shop's [directory row](directory-row.md). That row records which [shop cell](shop-cell.md) holds the shop. A move between cells is a [conditional write](durable-conditional-write.md): it succeeds only if the caller names the version that is currently stored. If someone else changed the row first, the move answers [`stale_version`](stale-version.md). Design intent (not stated in the spec): this stops two [admins](platform-admin.md) from overwriting each other's moves without noticing.

## Example
An admin reads `GET /admin/shops/:shopId/directory` and sees version 7 (illustrative). A second admin moves the shop first, so the version becomes 8. The first admin's `PUT /admin/shops/:shopId/directory` still names version 7. It gets `409 stale_version`, and the shop stays where the second admin put it.

## Known gaps
- The spec does not say how the version is sent on the `PUT` (for example, a body field or a header), or what the field is called.
- The spec does not say whether the `GET` answer includes the version.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-25
- [directory-row](directory-row.md)
- [durable-conditional-write](durable-conditional-write.md)
- [platform-admin](platform-admin.md)
- [shop-cell](shop-cell.md)
<!-- used-by:end -->
