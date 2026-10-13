---
id: shop-role
title: Shop role
kind: term
status: draft
aliases: [admin, owner, roles, staff]
defined_for: tenant-shop-rbac
rules_hash: 74c9fae60943
---
# Shop role
## Definition
A shop role is the level a person who belongs to a store holds inside that one store: `OWNER`, `ADMIN`, `STAFF` or `VIEWER`. The role decides which actions that person is allowed to take, through a fixed table that maps each role to its allowed actions. Roles form a ladder: each lower role is allowed a subset of the actions of the role above it. A person's role also limits which roles they may assign to others.

## Example
A member with `ADMIN` in a shop may make another member `STAFF` or `VIEWER`. Only an `OWNER` may make someone `ADMIN` or `OWNER`. An unknown role value, such as an illustrative `SUPERUSER`, is denied.

## Known gaps
- The spec does not say whether one user can hold different roles in different shops. Roles are per [membership](seat.md), so this is likely, but it is not stated.
- The spec does not say the exact order of `STAFF` and `VIEWER`. Only the `OWNER` and `ADMIN` limits are given explicitly.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-18, B-01
- [S03](../capabilities/S03-shops-rbac.md): R-06, R-07, B-02, B-06, B-12
- [S32](../capabilities/S32-product-search.md): R-21
- [W07](../capabilities/W07-app-shell.md): B-04
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md): C-04
- [get-shop-by-id](get-shop-by-id.md)
- [invite-acceptance](invite-acceptance.md)
- [is-admin](is-admin.md)
- [legacy-seller](legacy-seller.md)
- [membership-query-service](membership-query-service.md)
- [my-role](my-role.md)
- [permission-denied](permission-denied.md)
- [permission](permission.md)
- [post-auth-register](post-auth-register.md)
- [post-bff-session-refresh](post-bff-session-refresh.md)
- [presentation-only](presentation-only.md)
- [role-permission-matrix](role-permission-matrix.md)
- [seat](seat.md)
- [shop-access-service](shop-access-service.md)
- [shop-member](shop-member.md)
- [shop-membership](shop-membership.md)
- [shop-not-found](shop-not-found.md)
- [shop-tenant](shop-tenant.md)
<!-- used-by:end -->
