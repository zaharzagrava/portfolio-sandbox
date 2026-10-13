---
id: shop-status-gate
title: Shop status gate
kind: term
status: draft
aliases: [status gate]
defined_for: tenant-shop-rbac
rules_hash: 7af11f803f5d
---
# Shop status gate
## Definition
The shop status gate is the last check on a shop request. It runs after [authentication](session-cookie.md), the `404` check and the [`403 permission_denied`](permission-denied.md) check. It limits what any member can do based on the shop's status, whatever their role. While a shop is [`SUSPENDED`](shop-status.md), only the [`shop.read`](permission.md), `members.read` and `shop.export` permissions are allowed.

## Example
An [`OWNER`](shop-role.md) of a `SUSPENDED` shop can still export the shop's data with `shop.export`. The same `OWNER` is blocked if they try to edit a product.

## Known gaps
- The spec does not say which error code the status gate returns.
- The spec does not list the shop statuses other than `SUSPENDED`, or what each of them allows.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-04
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md): C-03
- [insufficient-role](insufficient-role.md)
- [invite-not-found](invite-not-found.md)
- [permission-denied](permission-denied.md)
- [product-command-service](product-command-service.md)
- [session-cookie](session-cookie.md)
- [shop-access-service](shop-access-service.md)
- [shop-guard](shop-guard.md)
- [shop-member](shop-member.md)
- [shop-membership](shop-membership.md)
- [shop-product-search-route](shop-product-search-route.md)
<!-- used-by:end -->
