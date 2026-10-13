---
id: insufficient-role
title: insufficient_role (403)
kind: term
status: draft
aliases: [insufficient_role]
defined_for: tenant-shop-rbac
rules_hash: e3b0c44298fc
---
# insufficient_role (403)
## Definition
`insufficient_role` is the error a member gets for trying to manage a role above what their own role allows. Only an [`OWNER`](shop-role.md) may assign, change or remove `OWNER` or [`ADMIN`](shop-role.md). An `ADMIN` may manage only [`STAFF`](shop-role.md) and [`VIEWER`](viewer.md). This error is different from [`permission_denied`](permission-denied.md): the caller may manage members, just not at that role level.

## Example
An `ADMIN` tries to promote a `STAFF` member to `ADMIN`:
```
403  { "code": "insufficient_role" }   (body shape illustrative)
```
If the same caller is not a member of the shop at all, they get [`404 shop_not_found`](shop-not-found.md) instead. Rule C-03 puts the 404 check before any 403.

## Known gaps
- The spec does not say whether `insufficient_role` comes before or after the [`SUSPENDED` status gate](shop-status-gate.md). Rule C-03 places the gate after `403 permission_denied` and does not mention this code.

## Used by
<!-- used-by:start -->
- [shop-status-gate](shop-status-gate.md)
<!-- used-by:end -->
