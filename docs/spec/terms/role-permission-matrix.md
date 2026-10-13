---
id: role-permission-matrix
title: Role permission matrix
kind: term
status: draft
aliases: [matrix]
defined_for: tenant-shop-rbac
rules_hash: 6dcb531c5cef
---
# Role permission matrix
## Definition
The role permission matrix is the fixed table that says which [permissions](permission.md) each [shop role](shop-role.md) holds. Rule C-04 requires each role's permissions to match the matrix in requirement FR-020 exactly. Roles are nested: a lower role holds a subset of the permissions of the role directly above it. Any role or permission that is not in the matrix is denied.

## Example
A [`SUSPENDED` shop](shop-status.md) still allows only `shop.read`, `members.read` and `shop.export`. So these are permissions that appear in the matrix. A request that checks a permission that is not in the matrix, such as an illustrative `shop.teleport`, is denied.

## Known gaps
- The spec does not say what the matrix contains: FR-020 was not provided, so the full list of permissions per role is unknown.
- The spec does not say which permissions [S05 (product CRUD)](../capabilities/S05-products.md) or [S53](../capabilities/S53-events-projections.md) need from the matrix.
- The spec does not say whether `STAFF` ranks above `VIEWER`. The nesting rule depends on that order.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-06
- [S28](../capabilities/S28-notifications.md): B-13
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md): C-04
- [get-shop-export](get-shop-export.md)
- [pending-invite](pending-invite.md)
- [permission-denied](permission-denied.md)
- [permission](permission.md)
- [shop-role](shop-role.md)
- [shop-status](shop-status.md)
- [shop-tenant](shop-tenant.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
