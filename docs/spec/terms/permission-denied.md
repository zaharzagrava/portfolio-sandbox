---
id: permission-denied
title: permission_denied (403)
kind: term
status: draft
aliases: [permission_denied]
defined_for: tenant-shop-rbac
rules_hash: e3b0c44298fc
---
# permission_denied (403)
## Definition
`permission_denied` is the `403` error returned when the caller is a member of the shop but their [role](shop-role.md) does not hold the permission the action needs. It is checked after [`401 invalid_token`](invalid-token-error.md) and after `404`, and before the [shop status gate](shop-status-gate.md). It is a different error from [`403 insufficient_role`](insufficient-role.md). That error covers role management, for example an `ADMIN` trying to change an `OWNER`.

## Example
A member with the `VIEWER` role tries an action whose permission their role lacks, such as editing a product. They get `403 permission_denied`. This example is illustrative, because the [permission matrix](role-permission-matrix.md) was not given.

## Known gaps
- The spec does not say which permissions each role holds. The FR-020 matrix was not given.
- The spec does not say which permissions S05 and S53 need.

## Used by
<!-- used-by:start -->
- [role-permission-matrix](role-permission-matrix.md)
- [shop-role](shop-role.md)
- [shop-status-gate](shop-status-gate.md)
<!-- used-by:end -->
