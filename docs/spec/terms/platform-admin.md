---
id: platform-admin
title: Platform admin
kind: term
status: draft
aliases: [admin]
defined_for: S03-shops-rbac
rules_hash: 124df97b0058
---
# Platform admin
## Definition
A platform admin is a user who runs the whole marketplace. This role is not the [`ADMIN` shop role](shop-role.md) inside one shop. Platform admins can [suspend a shop](shop-status.md), reinstate it, and move it to another [shop cell](shop-cell.md) through the `/admin/shops/...` endpoints. The request must carry a [sensitive session](sensitive-route.md) that has not been revoked through [session revocation](session-revocation.md). Shop owners and shop admins cannot use these endpoints.

## Example
A platform admin moves a shop to another cell:
```
PUT /admin/shops/:shopId/directory
```
The same request from a shop `OWNER` who is not a platform admin is refused. If the platform admin's session has been revoked, the request is refused too.

## Known gaps
- The spec does not say how a user becomes a platform admin, or where that role is stored.
- The spec does not define a "sensitive session" for these endpoints. For example, it does not say whether the user must have recently passed an [MFA challenge](mfa-challenge.md).
- The spec does not say which error a non-admin or a revoked session receives on these endpoints.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-25
- [S10](../capabilities/S10-cart-checkout.md): R-36
- [S32](../capabilities/S32-product-search.md): R-21
- [actor-id](actor-id.md)
- [adjusted-resolution](adjusted-resolution.md)
- [allowed-region](allowed-region.md)
- [directory-row](directory-row.md)
- [directory-version](directory-version.md)
- [finance-reconciliation-api](finance-reconciliation-api.md)
- [get-order-by-id](get-order-by-id.md)
- [issue-already-resolved](issue-already-resolved.md)
- [issue](issue.md)
- [mfa-challenge](mfa-challenge.md)
- [post-finance-reconciliation-issue-resolve](post-finance-reconciliation-issue-resolve.md)
- [reconciliation-controller](reconciliation-controller.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-resolution](reconciliation-resolution.md)
- [sensitive-route](sensitive-route.md)
- [session-revocation](session-revocation.md)
- [shop-cell-directory-row](shop-cell-directory-row.md)
- [shop-cell-move](shop-cell-move.md)
- [shop-cell](shop-cell.md)
- [shop-role](shop-role.md)
- [shop-status](shop-status.md)
- [unknown-cell](unknown-cell.md)
<!-- used-by:end -->
