---
id: permission
title: Permission
kind: term
status: draft
aliases: [members.read, permissions, shop.read]
defined_for: tenant-shop-rbac
rules_hash: 2bb9abbc6a40
---
# Permission
## Definition
A permission is a named right to do one kind of action inside a [shop](shop-tenant.md), such as `shop.read` or `shop.export`. Each [role](shop-role.md) (`OWNER`, `ADMIN`, `STAFF`, `VIEWER`) has a fixed set of permissions laid down in FR-020. Each lower role holds a subset of the permissions of the role just above it. An unknown permission or an unknown role is always denied. A missing permission gets `[403 permission_denied](permission-denied.md)`.

## Example
These are the only permissions allowed while a shop is [`SUSPENDED`](shop-status.md):
```
shop.read, members.read, shop.export
```

## Known gaps
- The spec does not give the full list of permissions or the FR-020 matrix.
- The spec does not say which permissions S05 and S53 check.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-06, R-07
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md): C-04
- [member-view](member-view.md)
- [my-role](my-role.md)
- [role-permission-matrix](role-permission-matrix.md)
- [shop-membership](shop-membership.md)
- [shop-role](shop-role.md)
- [shop-tenant](shop-tenant.md)
- [source-of-truth](source-of-truth.md)
- [tenancy-tables](tenancy-tables.md)
<!-- used-by:end -->
